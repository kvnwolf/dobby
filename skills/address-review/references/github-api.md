# GitHub review-thread mechanics (tool-agnostic)

Every command here is identical regardless of which review bot posted the findings. The only tool-specific values (`reTrigger`, `intentionalReply`, bot logins) come from `adapters.md`. Derive `OWNER`/`REPO` from `gh repo view --json owner,name` and the PR number from the current branch — nothing is hardcoded.

## Identify the PR

```bash
gh pr view --json number,headRefName,headRefOid,url
```

## Fetch open review threads

Keep only `isResolved=false`. The comment's `databaseId` is the REST id you need to reply (below); `author.login` drives adapter detection.

```bash
gh api graphql -f query='
query($cursor: String) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes { databaseId author { login } body }
          }
        }
      }
    }
  }
}'
```

If `hasNextPage` is true, repeat with `-f cursor=ENDCURSOR`.

## Read the summary + confidence (edited in place)

The bot keeps ONE issue comment and edits it every review cycle — no append. Select by `updated_at`, never `created_at`, or you'll read a stale body. The per-cycle timeline lives in the PR's review objects + GitHub's "edited" history, not in the summary.

```bash
gh api --paginate "repos/OWNER/REPO/issues/PR_NUMBER/comments?per_page=100" \
  | jq -s 'add
    | map(select(.user.login | test("BOT_LOGIN"; "i")))
    | sort_by(.updated_at) | last
    | {author: .user.login, updated_at, body}'
```

Parse the body for a confidence pattern like `4/5` or `Confidence: 4/5` and any residual concerns it still lists.

## Reply to a thread

REST, replying to the thread's FIRST comment by its `databaseId` (from the fetch above). Use for deferred/dismissed threads and for rebuttals — include the `adapter.intentionalReply` mention so the bot learns.

```bash
gh api --method POST "repos/OWNER/REPO/pulls/PR_NUMBER/comments" \
  -f body="@bot deferred — <reason>" \
  -F in_reply_to=DATABASE_ID
```

## Resolve threads (explicitly — push does NOT do this)

Batch every addressed thread into one mutation with GraphQL aliases. Thread ids are the `id` (`PRRT_…`) from the fetch.

```bash
gh api graphql -f query='
mutation {
  t1: resolveReviewThread(input: {threadId: "PRRT_ID_1"}) { thread { isResolved } }
  t2: resolveReviewThread(input: {threadId: "PRRT_ID_2"}) { thread { isResolved } }
}'
```

## Re-trigger a review

An issue comment carrying the adapter's trigger phrase. Skip in human/unknown mode.

```bash
gh pr comment PR_NUMBER --body "ADAPTER_RETRIGGER"   # e.g. "@greptileai review"
```

## Read the status check / confidence gate

```bash
gh pr checks PR_NUMBER
gh pr view PR_NUMBER --json statusCheckRollup
```

Some tools (Greptile) expose the numeric confidence only on their dashboard, not in the check payload — read what the check gives, then confirm the threshold with the user (see `adapters.md`).
