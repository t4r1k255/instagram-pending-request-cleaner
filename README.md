# Instagram Pending Request Cleaner

A local Chrome/Edge extension that reads usernames from an XLSX, CSV, TSV,
JSON, or HTML export, resolves each account's current Instagram user ID,
checks its relationship state, and cancels only confirmed outgoing requests.

> This uses unofficial Instagram web endpoints. Instagram can change them, limit
> actions, request verification, or restrict an account. No delay setting can
> guarantee that an account will not be limited. Use only on your own account
> and review a small dry-run before enabling cancellation.

## Features

- No password entry, external server, remote code, or analytics
- Local XLSX reader with no runtime dependency or CDN
- Instagram JSON support for both `string_list_data` exports and
  `label_values` records containing Name, URL, and Username fields
- Sheet and username-column selection
- Automatic username → current Instagram user ID resolution
- Mandatory pre-check so accepted requests are never unfollowed
- Direct GraphQL cancellation with response identity verification
- Configurable request delay, retry count, strict verification, and batch size
- One dedicated Instagram runner tab that can stay in the background
- Dry-run mode
- Pause, resume, batch pause, and browser-close recovery
- CSV result export
- Runtime tokens remain in page memory and are never written to extension storage

## Install

1. Download and extract the release ZIP.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. You can do for other browsers too.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted extension folder.
5. Open Instagram and sign in normally. Complete 2FA in Instagram if asked.

No Python, Node.js, npm, account password, or API key is required.

## Prepare the list

For an XLSX or CSV file, place the column name in row 1 and usernames or
Instagram profile URLs from row 2 onward.

| username |
| --- |
| example_one |
| https://www.instagram.com/example.two/ |

Blank rows, invalid values, and duplicate usernames are ignored. JSON and HTML
Instagram exports are scanned for username/profile links automatically.
Instagram export files can contain an `fbid` value, but that value is not
assumed to be Instagram's mutation target ID. It is retained only as
`export_fbid`; the current `instagram_user_id` is resolved at run time.

## Use

1. Click the extension icon and select the exported file.
2. Select the worksheet and username column.
3. Set the request delay, retry count, verification mode, and batch size. `0`
   processes the entire remaining list without a batch pause.
4. Start with **Preview mode** enabled and a very small list.
5. Review the preview results, then re-import and start without Preview mode.
6. The extension creates one Instagram runner tab. It can remain inactive in
   the background. If Instagram requests login or verification, the tab is
   brought forward; finish the check and click **Continue**.
7. Download results as CSV when needed.

For every username, the runner resolves the current Instagram ID and reads the
current friendship state before taking action. If `following: true`, the request
has already been accepted and the account is skipped. If
`outgoing_request: false`, there is no pending request and the account is also
skipped. The destructive mutation is sent only after
`outgoing_request: true` is confirmed.

A successful mutation must return the expected username and ID together with
`outgoing_request: false` and `following: false`. Strict verification performs
one additional friendship-status query after the mutation. Without strict
verification, the verified mutation response is used to avoid doubling every
request. Closing the dedicated runner tab pauses the queue. Progress is saved
after every account so the run can be resumed.

The extension observes Instagram's current in-page GraphQL transport and can
learn a newer unfollow mutation document when one is used manually. A current
fallback document ID is included, but if Instagram rotates it and rejects the
mutation, the extension stops instead of falling back to blind UI clicks. The
runner tab is brought forward; manually cancel one known pending request in
that same tab, then press **Continue** so the captured current template can be
used for the remaining queue.

## Result statuses

| Status | Meaning |
| --- | --- |
| `success` | Pending request was cancelled and the network response was verified |
| `would-cancel` | Dry-run confirmed a pending request |
| `not-requested` | No outgoing request exists now |
| `accepted` | The request was accepted; the followed account was left untouched |
| `not-found` | Profile was unavailable |
| `login-required` | Login or verification is required; item remains pending |
| `setup-required` | The mutation document changed; one manual capture is required |
| `failed` | The expected page state could not be verified |

## Development

The extension uses plain JavaScript and has no build step.

```bash
npm test
```

`npm install` is not needed; the test command has no package dependency.

Instagram's private web responses and GraphQL document IDs can change. Keep
cancellation logic conservative: resolve identity, confirm the current outgoing
request, verify the mutation identity, and stop on ambiguous responses.

## Publishing safely

Do not commit exports, result files, browser profiles, cookies, tokens, or real
usernames. The included `.gitignore` excludes common local data folders and ZIP
artifacts. Use sanitized examples in issues and screenshots.

## License

MIT
