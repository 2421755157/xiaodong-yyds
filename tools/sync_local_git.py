#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把远端 commit 对象同步进本地 git 对象库

背景：本机 github.com:443 直连不通、代理也 502，只有 api.github.com 可达，
      常规 `git push` 失败，改用 Git Data API 推送（tools/push_via_api.py）。
      但 API 建的 commit 对象不在本地 git 对象库里 →
      `git status` 会认为本地与远端分叉，origin/main 也无法更新。

做法：
  1) 从 API 拉全部 blob，写进本地对象库（git hash-object -w，sha 自然一致）
  2) 用**临时索引**（GIT_INDEX_FILE）+ `git update-index --add --cacheinfo`
     把这些 blob 组装成 tree —— git 自己处理目录层级，不会有 mktree 的坑
     （mktree 不接受带斜杠的路径，会报 "contains slash"）
  3) 用远端的 author/committer/date/message/parent 重建 commit
  4) update-ref 修正 origin/main
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.request

REPO = '2421755157/xiaodong-yyds'
API = 'https://api.github.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_cred():
    p = subprocess.run(['git', 'credential', 'fill'],
                       input='protocol=https\nhost=github.com\n\n',
                       capture_output=True, text=True, timeout=60)
    user = pw = ''
    for line in p.stdout.splitlines():
        if line.startswith('username='):
            user = line[9:]
        elif line.startswith('password='):
            pw = line[9:]
    return user, pw


def api(method, path, token, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(API + path, data=body, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'workbuddy-sync',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def git(args, **kw):
    return subprocess.run(['git'] + args, cwd=ROOT, capture_output=True, text=True, **kw)


def main():
    user, token = get_cred()
    if not token:
        print('取不到凭据')
        return 1

    ref = api('GET', '/repos/%s/git/ref/heads/main' % REPO, token)
    remote_sha = ref['object']['sha']
    print('远端 main: %s' % remote_sha)

    if git(['cat-file', '-e', remote_sha]).returncode == 0:
        print('本地已有该 commit 对象')
        git(['update-ref', 'refs/remotes/origin/main', remote_sha])
        print('origin/main 已指向 %s' % remote_sha)
        print(git(['status', '-sb']).stdout)
        return 0

    commit = api('GET', '/repos/%s/git/commits/%s' % (REPO, remote_sha), token)
    tree_sha = commit['tree']['sha']
    tree = api('GET', '/repos/%s/git/trees/%s?recursive=1' % (REPO, tree_sha), token)
    blobs = [t for t in tree['tree'] if t['type'] == 'blob']
    print('拉取 %d 个 blob…' % len(blobs))

    # 1) 写 blob
    for i, b in enumerate(blobs):
        d = api('GET', '/repos/%s/git/blobs/%s' % (REPO, b['sha']), token)
        raw = base64.b64decode(d['content'])
        p = subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=ROOT,
                           input=raw, capture_output=True)
        if p.stdout.decode().strip() != b['sha']:
            print('  !! blob sha 不符: %s' % b['path'])
        if (i + 1) % 20 == 0:
            print('  %d/%d' % (i + 1, len(blobs)))
            time.sleep(0.15)

    # 2) 用临时索引组装 tree
    idx = os.path.join(tempfile.gettempdir(), 'wb_sync_index')
    if os.path.exists(idx):
        os.remove(idx)
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    entries = []
    for b in blobs:
        entries += ['--cacheinfo', '%s,%s,%s' % (b['mode'], b['sha'], b['path'])]
    p = subprocess.run(['git', 'update-index', '--add'] + entries,
                       cwd=ROOT, capture_output=True, text=True, env=env)
    if p.returncode != 0:
        print('update-index 失败: %s' % p.stderr.strip()[:300])
        return 1
    p = subprocess.run(['git', 'write-tree'], cwd=ROOT,
                       capture_output=True, text=True, env=env)
    new_tree = p.stdout.strip()
    print('本地 tree: %s\n远端 tree: %s  %s'
          % (new_tree, tree_sha, '✓ 一致' if new_tree == tree_sha else '✗ 不一致'))
    if os.path.exists(idx):
        os.remove(idx)

    # 3) 重建 commit（用远端元数据）
    a, c = commit['author'], commit['committer']
    cenv = dict(os.environ, GIT_AUTHOR_NAME=a['name'], GIT_AUTHOR_EMAIL=a['email'],
                GIT_AUTHOR_DATE=a['date'], GIT_COMMITTER_NAME=c['name'],
                GIT_COMMITTER_EMAIL=c['email'], GIT_COMMITTER_DATE=c['date'])
    # parent 必须是**本地已有**的对象；远端的 parent sha 可能还没同步进来
    parents = []
    for par in commit['parents']:
        psha = par['sha']
        if git(['cat-file', '-e', psha]).returncode != 0:
            # 该 parent 不在本地 → 用它的 tree 重建一个等价 commit
            _pc = api('GET', '/repos/%s/git/commits/%s' % (REPO, psha), token)
            _pt = api('GET', '/repos/%s/git/trees/%s?recursive=1' % (REPO, _pc['tree']['sha']), token)
            for t in _pt['tree']:
                if t['type'] != 'blob':
                    continue
                _bd = api('GET', '/repos/%s/git/blobs/%s' % (REPO, t['sha']), token)
                subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=ROOT,
                               input=base64.b64decode(_bd['content']), capture_output=True)
            _a, _c = _pc['author'], _pc['committer']
            _env = dict(os.environ, GIT_AUTHOR_NAME=_a['name'], GIT_AUTHOR_EMAIL=_a['email'],
                        GIT_AUTHOR_DATE=_a['date'], GIT_COMMITTER_NAME=_c['name'],
                        GIT_COMMITTER_EMAIL=_c['email'], GIT_COMMITTER_DATE=_c['date'])
            _par = []
            for _pp in _pc['parents']:
                if git(['cat-file', '-e', _pp['sha']]).returncode == 0:
                    _par += ['-p', _pp['sha']]
            _r = subprocess.run(['git', 'commit-tree', _pc['tree']['sha']] + _par, cwd=ROOT,
                                input=_pc['message'], capture_output=True, text=True, env=_env)
            psha = _r.stdout.strip()
            print('  重建缺失的 parent → %s' % psha[:8])
        parents += ['-p', psha]
    p = subprocess.run(['git', 'commit-tree', new_tree] + parents, cwd=ROOT,
                       input=commit['message'], capture_output=True, text=True, env=cenv)
    new_commit = p.stdout.strip()
    if not new_commit:
        print('commit-tree 失败: %s' % p.stderr.strip()[:200])
        return 1
    same = new_commit == remote_sha
    print('本地 commit: %s\n远端 commit: %s  %s'
          % (new_commit, remote_sha, '✓ 一致' if same else '✗ sha 不同（内容等价）'))
    if not same:
        # sha 不同：用本地这个等价 commit 作为 origin/main，保证工作区干净
        git(['update-ref', 'refs/remotes/origin/main', new_commit])
        print('→ 用本地等价 commit 作为 origin/main')
    else:
        git(['update-ref', 'refs/remotes/origin/main', remote_sha])
    print('\n' + git(['status', '-sb']).stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
