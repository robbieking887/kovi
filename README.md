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

# Kovi Fleet: the real app (Google Cloud)

One small Node service on **Cloud Run** serves the app and the API. Data lives in **Cloud SQL (Postgres)**, photos in **Cloud Storage**, and **Cloud Scheduler** raises invoices on the 1st of each month.

## Go live (about 15 minutes, one time)

1. Make a Google Cloud account (cloud.google.com, the 90-day credit applies) and create a project. Turn on billing for it (needed even with free credit).
2. Open **Cloud Shell** (the `>_` button top right in the Google Cloud console). It already has `gcloud` installed.
3. In Cloud Shell:

        git clone https://github.com/robbieking887/kovi && cd kovi
        ./deploy.sh YOUR_PROJECT_ID you@youremail.com

   The email is yours: whoever signs up with that address becomes the **platform owner** (sees all customers, runs billing). It prints your live web address when done.
4. Open the address on your phone, tap **Company owner? Create your company**, sign up with that email. Share the **driver code** (People tab) and each driver makes their own login.
5. "Add to Home Screen" on the phone for an app icon. Google gives you an https address automatically, which phones need for GPS and compass. Add your own domain later in Cloud Run > Manage custom domains.

To update after any change: pull the latest and run `./deploy.sh` again with the same arguments. It keeps your data.

## Alert emails
Alerts always show in the app. For email, make a free Resend account and re-run `./deploy.sh PROJECT EMAIL YOUR_RESEND_KEY`. Until you verify a domain with Resend it only emails your own Resend address; then set `MAIL_FROM` on the Cloud Run service.

## Rules built in
- **Pricing:** £1 per vehicle per week, any week started counts, 7-day blocks from the day added, VAT 20%. Invoices are created automatically on the 1st (Cloud Scheduler); the Platform tab can run it on demand (safe to repeat).
- **Drivers** see only their own last 7 days. **Admins** see all time (History tab, filter by vehicle, driver, date, result). An admin can also do checks. Nothing is ever deleted.
- **Checks:** per section the driver confirms the listed items in one tap, or reports a defect. Plate photo, GPS within 50 m of the vehicle, compass sweep of all 4 sides on the walk-round, minimum time per page. Failures create alerts on the server.
- Works offline: checks save on the phone and upload when signal returns.

## Cost
Roughly £25-35/month once the free credit ends (Cloud SQL smallest instance is most of it; Cloud Run scales to zero; photo storage is pennies). Check Google's current pricing.

## Not built yet
Automatic card collection (Stripe) and Xero sync. Invoices are viewable/printable and you mark them paid by hand.

## Tests
`tests/e2e.js` drives the real app in a headless browser against a running server and Postgres (signup, driver join, check with defect, alerts, History, photos, permissions, billing). The Google Cloud deploy script itself could not be run from where it was written, so expect to fix a typo or a permission prompt on the first run.

The earlier Supabase version is kept in `legacy/` for reference.
