import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyCommand, positionalsIfAllowed } from "../read-only.ts";

const READ_ONLY = [
	"ls -la",
	"cd ~/repos/pi-extensions && git status --short && git log --oneline -5",
	"rg -n 'foo|bar' packages/ | head -20",
	"rg -niw --hidden -g '*.ts' -A3 --max-count=2 todo src",
	"rg -e --pre=x file.txt",
	"git --no-pager diff HEAD~1 -- README.md",
	"git -C ~/repos/homelab log -3 --format='%h %s'",
	"git log --since=2.weeks --author=hank --stat=200 -M50% -p",
	"git show --name-only HEAD",
	"git diff --cached --stat",
	"git status --porcelain=v2 -uno",
	"git grep -n -e TODO -- '*.ts'",
	"git branch --show-current",
	"git branch -a",
	"git branch --contains abc123",
	"git branch --list 'feat/*'",
	"git remote -v",
	"git stash list",
	"git worktree list",
	"git config --get remote.origin.url",
	"git reflog",
	"git reflog show main",
	"git fetch --prune origin",
	"git fetch https://github.com/x/y.git main",
	"git rev-parse --abbrev-ref HEAD",
	"git tag --contains HEAD",
	"git tag -l 'v1.*' --sort=-v:refname",
	"gh label list",
	"gh pr view 12 --json state,mergedAt --jq '.state'",
	"gh pr checks 12 --watch --interval 10",
	"gh run view 123 --log-failed",
	"gh api repos/hank-warren/pi-extensions/pulls --paginate --jq '.[].number'",
	"gh auth status",
	"jq '.rules | length' config.json 2>/dev/null",
	"wc -l *.ts 2>&1 | sort -n | tail -5".replace("sort -n", "head -50"),
	"grep -c x file >/dev/null && echo yes || echo no",
	"cat < input.txt",
	"echo hi >&2",
	"ls 2>&-",
	"timeout 10 git fetch origin",
	"# just a comment\nls",
	"command -v node",
	'grep "a\\b" file',
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
	"git grep -O vim foo",
	"git worktree add ../x",
	"git remote add up https://example.com/x.git",
	"git checkout main",
	"gh pr merge 12 --squash",
	"gh api -X POST repos/x/y/issues",
	"gh api --method=DELETE repos/x/y",
	"gh api graphql -f query=x",
	"gh pr view 12 --web",
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"cat x | tee out.txt",
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
	"rg --pre ./evil pattern",
	"rg --pre-glob '*' --pre ./evil pattern",
	"python3 -c 'print(1)'",
	"sed -n 1,5p file",
	"xargs rm",
	"printenv",
	"timeout 10 rm -rf x",
	"ls 'unterminated",
	// Programs that left the fast path: their safety hinged on spotting bad flags.
	"find . -name '*.ts'",
	"sort -o out.txt in.txt",
	"docker ps",
	"kubectl get pods",
	"systemctl status nginx",
	"journalctl -u x",
	"npm ls",
	"date -s '2020-01-01'",
	"tree -o out.txt",
	// Credentials printed by otherwise read-only commands.
	"gh auth status --show-token",
	"gh auth status -t",
	"kubectl get secrets,pods -o yaml",
	"jq -n env",
	"jq -n '$ENV.GITHUB_TOKEN'",
	// Recovery history and local refs.
	"git reflog expire --expire=now --all",
	"git reflog delete HEAD@{1}",
	"git fetch origin +main:main",
	"git fetch origin main:refs/heads/main",
	"git fetch --prune --prune-tags origin",
	"git fetch --upload-pack=evil origin",
	// A flag hidden by a quoted line continuation is still a flag.
	'rg "--pre\\\n=./script" pattern',
	// A redirect whose fd word is really a file name.
	"echo overwrite >&1report.txt",
	"echo x >&2x",
	"echo x >& out.txt",
];

test("known read-only commands skip review", () => {
	for (const command of READ_ONLY) assert.equal(isReadOnlyCommand(command), true, command);
});

test("anything that writes, executes, expands, reveals credentials or is unknown goes to review", () => {
	for (const command of NOT_READ_ONLY) assert.equal(isReadOnlyCommand(command), false, command);
});

test("a flag that takes an attached value never swallows the next argument", () => {
	const spec = { shortAttached: "M", longOptional: ["--stat"] };
	assert.equal(positionalsIfAllowed(["-M", "--output=x"], spec), undefined);
	assert.equal(positionalsIfAllowed(["--stat", "--output=x"], spec), undefined);
	assert.deepEqual(positionalsIfAllowed(["-M50%", "--stat=200", "HEAD"], spec), ["HEAD"]);
});
