# Kovi

Vehicle walkaround checks for fleets. Drivers check a vehicle on their phone, the office sees every check, defects and alerts.

## Status
`demo/kovi-fleet.html` is a clickable single-file demo (driver app plus office dashboard). GPS, compass, signal and email are simulated. The real build is next.

## How it works
- **Drivers** sign in with name and PIN, pick or scan a vehicle, and work through the checklist: plate photo, licence/CPC, mileage, pass/defect per item, photos for defects, declarations, submit.
- **Proof the check was done:** the phone must stay within 50 m of the vehicle (GPS), sweep all four sides (compass), and spend the minimum time on each locked page. Anything that fails is flagged and the office is emailed.
- **Offline:** checks save on the phone and send when signal returns.
- **Office** sees the fleet board, alerts, drivers, can edit the checklist and page lock times, and marks defects as fixed.

## Pricing
- 1 pound per vehicle per week, same for every vehicle type.
- Any week started is a full week (7-day blocks from the day a vehicle is added), so one day on the account costs 1 pound.
- Invoiced monthly in arrears from the units on the account. Checks, drivers and office users are free.
- Vehicles can be added or removed at any time.

## Automatic accounting and billing
- **Monthly run** on the 1st at 06:00: builds an invoice per customer from the vehicles on the account (one line per vehicle, weeks started), adds VAT, emails it, and takes payment by card if auto-pay is on.
- **Failed payments:** declined cards are flagged, the customer is emailed a card-update link, and the payment is retried. Overdue invoices get reminders. The admin can retry, remind, or mark an invoice paid by bank transfer.
- **Customers** (office users) see usage, invoices and receipts, and manage their card, auto-pay, billing email and VAT number.
- **Admin** sees all customers, invoices, unpaid totals, VAT totals, and can copy all invoices as CSV.
- **Accounting sync:** invoices and payments are pushed to Xero (QuickBooks the same way) as they happen.
- In the real build Stripe Billing handles invoicing, card collection, retries and receipts; usage (vehicle-weeks) is reported to Stripe each month.

## Planned stack
Next.js web app (driver app as an installable PWA), Supabase (database, auth, storage), Stripe (monthly invoicing), email alerts.

# Kovi Fleet: the real app

Everything is in this repo and already connected to your Supabase project (`gvkkivzasyfmqltnekow`, eu-west-1).

## Go live in 5 minutes

1. **Host the `web` folder.** Easiest: Netlify (netlify.com) > Add new site > Import from GitHub > pick `robbieking887/kovi`. Publish directory is already set to `web` (see `netlify.toml`). No build step. Vercel or Cloudflare Pages work the same way. It has to be HTTPS, which all of them give you free, because phones only allow GPS and compass on HTTPS.
2. **Supabase > Authentication > Providers > Email:** turn **off** "Confirm email" so drivers can sign up and go straight in. (Or leave it on and drivers confirm by email first.)
3. **Supabase > Authentication > URL configuration:** set Site URL to your Netlify address.
4. **Create your company:** open the site, tap "Company owner? Create your company". You are the admin. People > shows your **driver code**.
5. **Drivers:** each opens the site, taps "Driver? Join with a company code", makes their own login. Admins can promote any driver to admin under People. An admin sees everything and can also do checks.
6. On a phone, "Add to Home Screen" makes it behave like an app.

## Make yourself the platform owner (sees all customers, runs billing)

Supabase > SQL editor:

    update public.profiles set is_platform_admin = true where email = 'YOUR LOGIN EMAIL';

A Platform tab appears with all customers and invoices.

## Alert emails

Alerts always show in the app. For emails: make a free Resend account (resend.com), then Supabase > Edge Functions > Secrets, add `RESEND_API_KEY`. Until you verify your own domain in Resend, it can only send to your own Resend email address. Once you verify a domain, also add the secret `MAIL_FROM` e.g. `Kovi <alerts@yourdomain.co.uk>`.

## Billing

- £1 per vehicle per week, any week started counts, 7-day blocks from the day added, VAT 20% (company setting).
- Invoices are generated automatically on the 1st of each month at 02:10 (`pg_cron`). Admins see live usage and invoices under Billing; you can print or save as PDF. Platform tab > "Generate last month's invoices" runs it on demand (safe to repeat).
- **Not built yet:** automatic card collection (Stripe) and Xero sync. Right now you mark invoices paid yourself (Platform tab). Both need your Stripe/Xero accounts and keys; say the word and they are next.

## What is checked on each walkaround

Plate photo, GPS position at the vehicle (flag if they move more than 50 m away), compass sweep of all 4 sides during the walk-round page, minimum time on each page, defects need a note (photo optional), declarations. Any failure creates an alert in the database (so the phone cannot skip it). Works offline: checks save on the phone and upload when signal returns.

## Tests

- Database permissions and billing maths were tested directly in Postgres (drivers cannot see alerts or add vehicles; companies cannot see each other; week counts).
- `tests/ui-smoke.js` drives the app in a headless browser against a fake backend.
- Not tested on a real phone yet: GPS accuracy and compass behaviour vary by phone, so do one real check yourself first.
