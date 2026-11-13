# Security policy

Fast Reader runs a native helper that parses PDFs with MuPDF, so malformed-file crashes and
memory-safety bugs are in scope.

## Reporting

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(https://github.com/Royshare/zotero-glide/security/advisories/new). Don't open a public issue for
an exploitable bug. Include the Fast Reader version, OS, and a sample PDF if you can share one.

This is a volunteer project: expect an initial response within about a week.

## Supported versions

Only the latest release receives fixes.

## Notes

- Release binaries are not yet code-signed or notarized; verify downloads against `SHA256SUMS` on the release.
- Vulnerabilities in MuPDF itself are best reported upstream as well (https://mupdf.com).
