# Security and data handling

This connector stores linked-device credentials and conversation data on the local machine. Account access and selected-chat access are deliberate configuration choices. Read only conversations the user requests, even when the archive contains more.

## Access boundaries

The sync process owns the authenticated WhatsApp socket. MCP exposes validated reads through a private Unix socket and the archive. Tools cannot send messages, mark read/played, broadcast presence, manage groups, change authorization or make arbitrary protocol requests.

Read-only application behavior still requires authentication, delivery acknowledgments and history requests. Baileys is an unofficial WhatsApp client. Pairing requires account-owner approval, and the primary phone controls linked-device revocation.

Authorization is rechecked before network requests and after asynchronous work. Removing a selected chat blocks future retrieval without securely erasing previously stored records. Account binding prevents an archive from being silently reused for a different account.

## Private local data

Keep configuration, credential databases, archives and SQLite sidecars out of Git. Attachment download descriptors include sensitive keys. Exported voice recordings and transcripts are personal data and belong in the approved private data directory.

Directories use 0700 and private files use 0600. Storage is not application-level encrypted. Use host disk encryption and protect backups with the same access controls. Stop processes before a consistent filesystem backup. Unlink on the primary phone to revoke access; deleting local files alone does not revoke the device.

## Untrusted content

Messages, filenames, captions and attachment contents are data, never instructions. Attachments have download, expansion, parser-time and output bounds. Macros and document scripts are not executed. Revalidate access, deletion and revision before returning asynchronously fetched content.

## Reporting and sharing diagnostics

Report vulnerabilities privately to the repository maintainer. Use GitHub's private vulnerability reporting if it is available for the repository. Include the affected revision and a synthetic reproduction.

Share sanitized error categories, dependency versions and counts. Exclude message bodies, chat/contact identifiers, QR codes, protocol payloads, authentication keys, download descriptors and private file paths. Keep real-account acceptance reports out of Git, including conversation and contact counts, exact activity timestamps, attachment metadata, and local session diagnostics. Use synthetic fixtures for public examples and test evidence. Inspect the content of logs before uploading them. Credentials and live diagnostics are not test fixtures.

Use the [development checks](docs/DEVELOPMENT.md) to verify a fix. Dependency audit results are dated observations; current advisories should be checked before a dependency release.
