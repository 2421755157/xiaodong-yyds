#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""通过 GitHub Git Data API 推送提交（绕过 git:// 端点）

背景：本机 github.com:443 直连不通、代理也 502，只有 api.github.com 可达。
      常规 `git push` 因此失败。GitHub 的 Git Data API 走 api.github.com，
      可以直接创建 blob/tree/commit 并更新分支引用。

用法：python tools/push_via_api.py
"""
import base64, json, os, subprocess, sys, time, urllib.request

REPO = '2421755157/xiaodong-yyds'
API = 'https://api.github.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_cred():
    """从 GCM 取 github.com 凭据"""
    p = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                       capture_output=True, text=True, timeout=60)
    user = pw = ''
    for line in p.stdout.splitlines():
        if line.startswith('username='):
            user = line[9:]
        elif line.startswith('password='):
            pw = line[9:]
    return user, pw


def api(method, path, token, data=None, raw=False):
    url = API + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'workbuddy-push',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'ignore')[:400]
        raise RuntimeError('%s %s → HTTP %s\n%s' % (method, path, e.code, detail))
    return t if raw else json.loads(t.decode())


def main():
    user, pw = get_cred()
    if not pw:
        print('取不到凭据')
        return 1
    print('凭据用户: %s' % user)

    # 1) 读本地 HEAD 与远端 main
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                          capture_output=True, text=True).stdout.strip()
    ref = api('GET', '/repos/%s/git/ref/heads/main' % REPO, pw)
    base_sha = ref['object']['sha']
    print('本地 HEAD  : %s' % head)
    print('远端 main  : %s' % base_sha)

    if head == base_sha:
        print('远端已是最新，无需推送')
        return 0

    # 2) 列出本次要推送的提交与文件
    # 基准用**远端当前 commit**（可能与本地 HEAD sha 不同，是上一轮 API 推的）
    cur_ref = api('GET', '/repos/%s/git/ref/heads/main' % REPO, pw)
    remote_now = cur_ref['object']['sha']
    # 用 tree sha 做 diff 基准：远端 commit 对象可能还没进本地对象库，
    # `git diff <commit>` 会因对象不可达而返回空 → 误判成"没东西要推"
    _rt = api('GET', '/repos/%s/git/commits/%s' % (REPO, remote_now), pw)['tree']['sha']
    files = subprocess.run(['git', 'diff', '--name-only', _rt, head], cwd=ROOT,
                           capture_output=True, text=True).stdout.split()
    if not files:
        # 退化：远端 tree 与本地 HEAD tree 相同 → 用远端 tree 的文件列表逐个比对
        _rt_full = api('GET', '/repos/%s/git/trees/%s?recursive=1' % (REPO, _rt), pw)
        _remote_files = {t['path'] for t in _rt_full['tree'] if t['type'] == 'blob'}
        _local = subprocess.run(['git', 'ls-tree', '-r', '--name-only', head], cwd=ROOT,
                                capture_output=True, text=True).stdout.split()
        files = [f for f in _local if f not in _remote_files]
        for t in _rt_full['tree']:
            if t['type'] == 'blob' and t['path'] not in set(_local):
                pass  # 远端多出来的文件 → 本地没有，暂不删（保守）
    print('待推送文件 %d 个' % len(files))

    msg = subprocess.run(['git', 'log', '-1', '--pretty=%B', head], cwd=ROOT,
                         capture_output=True, text=True).stdout.strip()
    author = subprocess.run(['git', 'log', '-1', '--pretty=%an <%ae>', head], cwd=ROOT,
                            capture_output=True, text=True).stdout.strip()

    # 3) 逐个建 blob（大文件分片上传，避免单请求过大）
    tree_entries = []
    for i, f in enumerate(files):
        p = os.path.join(ROOT, f)
        if not os.path.exists(p):
            print('  跳过已删除: %s' % f)
            continue
        content = open(p, 'rb').read()
        enc = base64.b64encode(content).decode()
        blob = api('POST', '/repos/%s/git/blobs' % REPO, pw, {'content': enc, 'encoding': 'base64'})
        tree_entries.append({'path': f, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        if (i + 1) % 5 == 0:
            print('  %d/%d blob 已建（%s %.0fKB）' % (i + 1, len(files), f, len(content) / 1024))
            time.sleep(0.2)

    # 4) 建 tree（基于远端当前 tree）
    parent_sha = base_sha
    try:
        cur = api('GET', '/repos/%s/git/ref/heads/main' % REPO, pw)
        parent_sha = cur['object']['sha']
    except Exception:
        pass
    print('parent: %s' % parent_sha)

    # GET /git/commits/{sha} 返回单个 commit 对象（含 tree.sha）
    base_tree = api('GET', '/repos/%s/git/commits/%s' % (REPO, parent_sha), pw)['tree']['sha']
    tree = api('POST', '/repos/%s/git/trees' % REPO, pw,
               {'base_tree': base_tree, 'tree': tree_entries})
    print('tree 已建: %s（%d 项）' % (tree['sha'], len(tree_entries)))

    # 5) 建 commit
    # parent 用**远端当前 commit**（不是本地 HEAD）：
    # 上一轮可能是用 API 推的，远端 sha 与本地 HEAD 不同，
    # 用本地 HEAD 当 parent 会 422（non-fast-forward）
    commit = api('POST', '/repos/%s/git/commits' % REPO, pw, {
        'message': msg, 'tree': tree['sha'], 'parents': [parent_sha],
        'author': {'name': author.split(' <')[0], 'email': author.split('<')[-1].rstrip('>'),
                   'date': subprocess.run(['git', 'log', '-1', '--pretty=%cI', head], cwd=ROOT,
                                          capture_output=True, text=True).stdout.strip()},
    })
    print('commit 已建: %s' % commit['sha'])

    # 6) 更新分支引用
    api('PATCH', '/repos/%s/git/refs/heads/main' % REPO, pw,
        {'sha': commit['sha'], 'force': False})
    print('main 已更新到 %s' % commit['sha'])

    # 7) 本地同步引用，避免下次误判
    subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', commit['sha']], cwd=ROOT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
