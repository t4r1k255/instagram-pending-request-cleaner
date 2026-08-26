# Privacy

This extension processes selected XLSX, CSV, TSV, JSON, and HTML files locally
in the browser. It does not request or store an Instagram password, two-factor
authentication code, cookie, or access token. It does not include analytics,
telemetry, advertising, or remote code.

The extension stores its queue, settings, progress, resolved Instagram user
IDs, relationship check labels, and results in `chrome.storage.local` so
interrupted work can be resumed. Resetting the queue removes this stored state.
The extension only has host access to `https://www.instagram.com/*`.

The extension reads Instagram's current CSRF/GraphQL transport values
temporarily in the Instagram page context and sends profile, friendship, and
cancellation requests from that same page. Cookies, CSRF values, the complete
request body, and raw responses are never sent to the extension queue, written
to storage, logged, exported, or included in result files. Only the resolved
Instagram user ID, normalized relationship checks, outcome, and a non-sensitive
reason code cross the page bridge.
