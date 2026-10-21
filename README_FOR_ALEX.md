# TESS SPACE — Legal & Compliance | implementation

**One public URL:** `legal.html`. The page is fully written in Danish and English, contains all 11 sections and does not display draft/pending/under-construction notices.

## Integration
1. Add `legal.html` to the website root (next to `index.html`).
2. Replace the footer links `Legal`, `Privacy Policy` and `Terms & Conditions` with one `Legal & Compliance` link; see `FOOTER_INTEGRATION.html`.
3. For forms and recruitment, use direct links `legal.html#da-privacy` / `legal.html#en-privacy`. For terms: `legal.html#da-terms` / `legal.html#en-terms`.
4. Preserve site branding, but do not redraw approved TESS SPACE logo; replace text brand only if using existing approved site logo asset.
5. Page has no analytics or tracking and does not store language selection. If analytics, videos, embedded widgets or non-essential cookies are added, deploy a real consent manager that blocks those technologies until consent and update the disclosure with actual provider, purpose and lifetime. No decorative consent banner.
6. Prefer local font hosting to avoid external requests.
7. Confirm email address `info@tess-space.com` and CVR/company address against business records before publishing. Confirm retention periods, mail/hosting processors, any third-country transfers and legal text with Tess Space. These are operational/legal sign-off items, **not** text placeholders on the public page.
8. Obtain legal review, especially for GDPR and defence/export-control language.

## What is included
`legal.html`: self-contained responsive bilingual page. `FOOTER_INTEGRATION.html`: footer snippet. `IMPLEMENTATION_CHECKLIST.md`: prelaunch checks.

## Important
This is an implementable editorial and technical draft, not a legal opinion or proof of compliance. No claim is made that optional technologies exist or are absent from all future site pages.
