#!/usr/bin/env bash
# Deploys Kovi to Google Cloud: Cloud Run (app) + Cloud SQL Postgres (data) + Cloud Storage (photos) + Cloud Scheduler (monthly invoices + 15-minute reminders).
# Safe to re-run: it reuses what exists and just redeploys the app.
# Usage:  ./deploy.sh YOUR_GCP_PROJECT_ID you@yourmail.com [RESEND_API_KEY]
set -euo pipefail
PROJECT="${1:?Usage: ./deploy.sh PROJECT_ID PLATFORM_ADMIN_EMAIL [RESEND_API_KEY]}"
ADMIN_EMAIL="${2:?Usage: ./deploy.sh PROJECT_ID PLATFORM_ADMIN_EMAIL [RESEND_API_KEY]}"
RESEND="${3:-}"
REGION=europe-west2          # London
SQL=kovi-db; DB=kovi; DBUSER=kovi
BUCKET="${PROJECT}-kovi-photos"
RUNSA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud config set project "$PROJECT"
echo "== Enabling Google Cloud services (takes a minute)"
gcloud services enable run.googleapis.com sqladmin.googleapis.com storage.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

secret() { # name value : create if missing, never overwrite
  if ! gcloud secrets describe "$1" >/dev/null 2>&1; then printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic; fi
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$RUNSA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
}

echo "== Database (Cloud SQL Postgres, smallest size, daily backups)"
if ! gcloud sql instances describe "$SQL" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL" --database-version=POSTGRES_15 --edition=ENTERPRISE --tier=db-f1-micro --region="$REGION" \
    --storage-size=10GB --storage-auto-increase --backup-start-time=03:00
  gcloud sql databases create "$DB" --instance="$SQL"
  DBPASS="$(openssl rand -hex 20)"
  gcloud sql users create "$DBUSER" --instance="$SQL" --password="$DBPASS"
  secret kovi-db-pass "$DBPASS"
fi

echo "== Photo storage bucket"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNSA" --role=roles/storage.objectAdmin --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNSA" --role=roles/cloudsql.client --condition=None >/dev/null
# newer Google Cloud projects do not let the default service account build from source until it is given the builder role
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNSA" --role=roles/cloudbuild.builds.builder --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNSA" --role=roles/run.builder --condition=None >/dev/null 2>&1 || true
sleep 20  # let the permissions settle

echo "== Secrets"
secret kovi-jwt "$(openssl rand -hex 32)"
secret kovi-cron "$(openssl rand -hex 24)"
SECRETS="DB_PASS=kovi-db-pass:latest,JWT_SECRET=kovi-jwt:latest,CRON_SECRET=kovi-cron:latest"
if [ -n "$RESEND" ]; then
  if gcloud secrets describe kovi-resend >/dev/null 2>&1; then printf '%s' "$RESEND" | gcloud secrets versions add kovi-resend --data-file=-; else secret kovi-resend "$RESEND"; fi
fi
if gcloud secrets describe kovi-resend >/dev/null 2>&1; then SECRETS="$SECRETS,RESEND_API_KEY=kovi-resend:latest"; fi

# Legal details shown in the Terms and Privacy pages. Set these in your shell first, e.g.
#   export LEGAL_NAME="Your Company Ltd" LEGAL_ADDRESS="1 High St, Glasgow G1 1AA" LEGAL_EMAIL="hello@yourdomain.co.uk" COMPANY_NUMBER=SC123456 ICO_NUMBER=ZA123456
LEGAL_ENV=""
for k in LEGAL_NAME LEGAL_ADDRESS LEGAL_EMAIL COMPANY_NUMBER ICO_NUMBER GOVERNING_LAW; do [ -n "${!k:-}" ] && LEGAL_ENV="$LEGAL_ENV#$k=${!k}"; done
[ -z "${LEGAL_NAME:-}" ] && echo "!! LEGAL_NAME is not set: the Terms and Privacy pages will show yellow placeholders until you set it and redeploy."

echo "== Deploying the app to Cloud Run"
gcloud run deploy kovi --source . --region "$REGION" --allow-unauthenticated \
  --add-cloudsql-instances "$PROJECT:$REGION:$SQL" \
  --set-env-vars "^#^DB_HOST=/cloudsql/$PROJECT:$REGION:$SQL#DB_USER=$DBUSER#DB_NAME=$DB#BUCKET=$BUCKET#PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL${LEGAL_ENV}" \
  --set-secrets "$SECRETS" --min-instances=0 --max-instances=5 --memory=512Mi
URL="$(gcloud run services describe kovi --region "$REGION" --format='value(status.url)')"
gcloud run services update kovi --region "$REGION" --update-env-vars "^#^APP_URL=$URL" >/dev/null   # so emailed alerts can link back to the app

echo "== Monthly invoice job (1st of each month, 02:10 London)"
CRON="$(gcloud secrets versions access latest --secret=kovi-cron)"
ARGS=(--location="$REGION" --schedule="10 2 1 * *" --time-zone=Europe/London --uri="$URL/api/cron/invoices" --http-method=POST --headers="x-cron-secret=$CRON")
gcloud scheduler jobs describe kovi-invoices --location="$REGION" >/dev/null 2>&1 && gcloud scheduler jobs update http kovi-invoices "${ARGS[@]}" || gcloud scheduler jobs create http kovi-invoices "${ARGS[@]}"

echo "== Reminder job (every 15 minutes: missed-check alerts, MOT/tax/service reminders, Monday PDF report)"
TARGS=(--location="$REGION" --schedule="*/15 * * * *" --time-zone=Europe/London --uri="$URL/api/cron/tick" --http-method=POST --headers="x-cron-secret=$CRON")
gcloud scheduler jobs describe kovi-tick --location="$REGION" >/dev/null 2>&1 && gcloud scheduler jobs update http kovi-tick "${TARGS[@]}" || gcloud scheduler jobs create http kovi-tick "${TARGS[@]}"

echo
echo "DONE. Kovi is live at: $URL"
echo "Open it, tap 'Company owner? Create your company' using $ADMIN_EMAIL to be the platform owner."
