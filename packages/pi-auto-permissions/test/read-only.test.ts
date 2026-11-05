import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyCommand, positionalsIfAllowed } from "../read-only.ts";

const READ_ONLY = [
	"ls -la",
	"cd ~/repos/pi-extensions && git status --short && git log --oneline -5",
	"git log --oneline | head -20",
	"git --no-pager log -p HEAD~1 -- README.md",
	"git -C ~/repos/homelab log -3 --format='%h %s'",
	"git log --since=2.weeks --author=hank --stat=200 -M50% -p",
	"git show --name-only HEAD",
	"git show --stat HEAD | tail -3",
	"git status --porcelain=v2 -uno",
	"git branch --show-current",
	"git branch -a",
	"git branch --contains=abc123",
	"git branch --list 'feat/*'",
	"git stash list",
	"git worktree list",
	"git reflog",
	"git reflog show main",
	"git fetch --prune origin",
	"git fetch https://github.com/x/y.git main",
	"git rev-parse --abbrev-ref HEAD",
	"git tag --contains=HEAD",
	"git tag -l 'v1.*' --sort=-v:refname",
	"gh pr view 12 --json state,mergedAt --jq '.state'",
	"gh pr checks 12 --watch --interval 10",
	"gh run view 123 --log-failed | grep -n -i error | head -40",
	"gh api repos/hank-warren/pi-extensions/pulls --paginate --jq '.[].number'",
	"gh pr list --json number | jq -r '.[].number'",
	"gh auth status",
	"gh label list",
	"ls -la 2>/dev/null | grep -c x >/dev/null && echo yes || echo no",
	"df -h . | tail -1 | cut -c1-20",
	"echo hi >&2",
	"ls 2>&-",
	"timeout 10 git fetch origin",
	"# just a comment\nls",
	"command -v node",
	"git ls-files | wc -l",
	"git log --format=%an | tr a-z A-Z",
];

const NOT_READ_ONLY = [
	"",
	"rm -rf build",
	"git push origin main",
	"git branch new-feature",
	"git branch -D old",
	"git stash",
	"git tag v1.0.0",
	"git tag --contains HEAD v2",
	"git -c core.pager=evil log",
	"git log --output=/tmp/x",
	"git diff --ext-diff",
	// Outside a worktree, or given a path outside it, diff and grep read arbitrary files.
	"cd /tmp && git diff /dev/null ~/.pi/agent/auth.json",
	"git diff --cached --stat",
	"git grep -n TODO",
	"git grep -O vim foo",
	"git grep --no-index foo /etc",
	"git worktree add ../x",
	"git remote -v",
	"git remote add up https://example.com/x.git",
	"git config --get remote.origin.url",
	"git checkout main",
	"gh pr merge 12 --squash",
	"gh api -X POST repos/x/y/issues",
	"gh api --method=DELETE repos/x/y",
	"gh api graphql -f query=x",
	"gh pr view 12 --web",
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"ls | tee out.txt",
	"ls $(pwd)",
	"ls `pwd`",
	"echo $HOME",
	'echo "$TOKEN"',
	'echo "\\$HOME"',
	"(cd /tmp && ls)",
	"{ ls; }",
	"sleep 100 &",
	"FOO=1 ls",
	"cat <<EOF\nhi\nEOF",
	"diff <(ls a) <(ls b)",
	"python3 -c 'print(1)'",
	"sed -n 1,5p file",
	"xargs rm",
	"printenv",
	"ps aux",
	"timeout 10 rm -rf x",
	"ls 'unterminated",
	// Programs that print file contents go to the guardian.
	"cat README.md",
	"cat ~/.pi/agent/auth.json",
	"cat < input.txt",
	// A filter fed a file through a redirect is reading that file.
	"head < ~/.pi/agent/auth.json",
	"grep x <~/.netrc",
	"wc -l <&3",
	// Flags that read a file named on the command line.
	"wc --files0-from ~/.pi/agent/auth.json",
	"wc -l README.md",
	"du --files0-from=x",
	"md5sum -c ~/.pi/agent/auth.json",
	"rg -n todo src",
	"head -20 ~/.ssh/id_ed25519",
	"tail -f /var/log/syslog",
	"grep -c x file",
	"grep -r token .",
	"grep -f ~/.ssh/id_rsa",
	"jq . config.json",
	"jq --rawfile k ~/.pi/agent/auth.json -n '$k'",
	"base64 ~/.ssh/id_rsa",
	"strings secret.bin",
	"diff a b",
	// printf -v assigns a shell variable, PATH included.
	"printf -v PATH ./bin; ls",
	"printf hello",
	// Unquoted globs expand to names this parser never sees, any of which can be a flag.
	"git diff *",
	"ls *.md",
	"wc -l ?.ts",
	"ls [a-z]*",
	// Programs whose safety hinged on spotting bad flags.
	"find . -name '*.ts'",
	"sort -o out.txt in.txt",
	"docker ps",
	"kubectl get secrets,pods -o yaml",
	"systemctl status nginx",
	"journalctl -u x",
	"npm ls",
	"date -s '2020-01-01'",
	"tree -o out.txt",
	// Credentials.
	"gh auth status --show-token",
	"gh auth status -t",
	"jq -n env",
	"jq -n '$ENV.GITHUB_TOKEN'",
	// Recovery history and local refs.
	"git reflog expire --expire=now --all",
	"git fetch origin +main:main",
	"git fetch origin main:refs/heads/main",
	"git fetch --prune --prune-tags origin",
	"git fetch --upload-pack=evil origin",
	// A flag hidden by a quoted line continuation is still a flag.
	'git log "--output\\\n=x"',
	// A redirect whose fd word is really a file name.
	"echo overwrite >&1report.txt",
	"echo x >&2x",
	"echo x >& out.txt",
	// A long flag with an optional value must not swallow the next argument.
	"grep --color -r .",
	"grep --colour -r . | head",
	"git log --format --output=x",
	"git status --porcelain --output=x",
	"gh pr view 1 -w --show-token",
	// A builtin that evaluates an array subscript runs the substitution inside it.
	"test -v 'BASH_VERSINFO[$(rm -rf ./pre-existing-dir)]'",
	"test -f README.md && echo yes",
];

test("known read-only commands skip review", () => {
	for (const command of READ_ONLY) assert.equal(isReadOnlyCommand(command), true, command);
});

test("anything that writes, executes, expands, reveals credentials or is unknown goes to review", () => {
	for (const command of NOT_READ_ONLY) assert.equal(isReadOnlyCommand(command), false, command);
});

test("a flag that takes an attached value never swallows the next argument", () => {
	const spec = { shortAttached: "M", longValue: ["--stat"] };
	assert.equal(positionalsIfAllowed(["-M", "--output=x"], spec), undefined);
	assert.equal(positionalsIfAllowed(["--stat", "--output=x"], spec), undefined);
	assert.deepEqual(positionalsIfAllowed(["-M50%", "--stat=200", "HEAD"], spec), ["HEAD"]);
});
