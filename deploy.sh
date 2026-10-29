#!/usr/bin/env bash
# Deploys Kovi to Google Cloud: Cloud Run (app) + Cloud SQL Postgres (data) + Cloud Storage (photos) + Cloud Scheduler (monthly invoices).
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
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$RUNSA" --role=roles/secretmanager.secretAccessor >/dev/null
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
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNSA" --role=roles/storage.objectAdmin >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNSA" --role=roles/cloudsql.client >/dev/null

echo "== Secrets"
secret kovi-jwt "$(openssl rand -hex 32)"
secret kovi-cron "$(openssl rand -hex 24)"
SECRETS="DB_PASS=kovi-db-pass:latest,JWT_SECRET=kovi-jwt:latest,CRON_SECRET=kovi-cron:latest"
if [ -n "$RESEND" ]; then
  if gcloud secrets describe kovi-resend >/dev/null 2>&1; then printf '%s' "$RESEND" | gcloud secrets versions add kovi-resend --data-file=-; else secret kovi-resend "$RESEND"; fi
fi
if gcloud secrets describe kovi-resend >/dev/null 2>&1; then SECRETS="$SECRETS,RESEND_API_KEY=kovi-resend:latest"; fi

echo "== Deploying the app to Cloud Run"
gcloud run deploy kovi --source . --region "$REGION" --allow-unauthenticated \
  --add-cloudsql-instances "$PROJECT:$REGION:$SQL" \
  --set-env-vars "DB_HOST=/cloudsql/$PROJECT:$REGION:$SQL,DB_USER=$DBUSER,DB_NAME=$DB,BUCKET=$BUCKET,PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL" \
  --set-secrets "$SECRETS" --min-instances=0 --max-instances=5 --memory=512Mi
URL="$(gcloud run services describe kovi --region "$REGION" --format='value(status.url)')"

echo "== Monthly invoice job (1st of each month, 02:10 London)"
CRON="$(gcloud secrets versions access latest --secret=kovi-cron)"
ARGS=(--location="$REGION" --schedule="10 2 1 * *" --time-zone=Europe/London --uri="$URL/api/cron/invoices" --http-method=POST --headers="x-cron-secret=$CRON")
gcloud scheduler jobs describe kovi-invoices --location="$REGION" >/dev/null 2>&1 && gcloud scheduler jobs update http kovi-invoices "${ARGS[@]}" || gcloud scheduler jobs create http kovi-invoices "${ARGS[@]}"

echo
echo "DONE. Kovi is live at: $URL"
echo "Open it, tap 'Company owner? Create your company' using $ADMIN_EMAIL to be the platform owner."
