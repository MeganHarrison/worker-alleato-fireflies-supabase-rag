# Deployment Guide for Fireflies-Supabase RAG Worker

## Prerequisites Checklist

Before deploying, ensure you have:
- [ ] Cloudflare account with Workers enabled
- [ ] Supabase project with pgvector extension enabled
- [ ] Fireflies.ai API key
- [ ] Hyperdrive configuration created

## Step 1: Create KV Namespace

Run these commands to create the KV namespace for caching:

```bash
# Create production KV namespace
npx wrangler kv namespace create CACHE

# Create preview KV namespace  
npx wrangler kv namespace create CACHE --preview
```

Save the IDs that are output - you'll need them for Step 2.

## Step 2: Update wrangler.jsonc

Update the KV namespace IDs in `wrangler.jsonc`:

```json
"kv_namespaces": [
  {
    "binding": "CACHE",
    "id": "YOUR_PRODUCTION_KV_ID",  // Replace with ID from step 1
    "preview_id": "YOUR_PREVIEW_KV_ID"  // Replace with preview ID from step 1
  }
]
```

Also update your Supabase URL:

```json
"vars": {
  "SUPABASE_URL": "https://YOUR-PROJECT-REF.supabase.co",  // Your actual Supabase URL
  // ... other vars
}
```

## Step 3: Set Required Secrets

Set each secret using wrangler:

```bash
# Supabase secrets
npx wrangler secret put SUPABASE_SERVICE_KEY
# Enter your Supabase service role key when prompted

npx wrangler secret put SUPABASE_ANON_KEY  
# Enter your Supabase anon key when prompted

# Fireflies API key
npx wrangler secret put FIREFLIES_API_KEY
# Enter your Fireflies API key when prompted

# Optional: Webhook secret for Fireflies webhooks
npx wrangler secret put FIREFLIES_WEBHOOK_SECRET
# Enter webhook secret if using webhooks
```

## Step 4: Verify Supabase Setup

1. Ensure pgvector extension is enabled:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

2. Run the database schema from `supabase-schema.sql`:
```bash
# Using Supabase CLI
supabase db push --db-url "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres"

# Or run the SQL directly in Supabase SQL Editor
```

3. Create the storage bucket:
- Go to Supabase Dashboard > Storage
- Create a new bucket named "meetings"
- Set it to public (for read access)

## Step 5: Deploy the Worker

```bash
# Deploy to production
pnpm deploy

# Or using wrangler directly
npx wrangler deploy

# To deploy to a specific environment
npx wrangler deploy --env production
```

## Step 6: Verify Deployment

Test the deployed worker:

```bash
# Check health endpoint
curl https://worker-alleato-fireflies-rag.[YOUR-SUBDOMAIN].workers.dev/api/health

# Test sync (will sync last 30 days by default)
curl -X POST https://worker-alleato-fireflies-rag.[YOUR-SUBDOMAIN].workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}'
```

## Step 7: Set Up Scheduled Sync (Optional)

The worker is configured to run daily at 2 AM UTC. This is already set in `wrangler.jsonc`:

```json
"triggers": {
  "crons": ["0 2 * * *"]
}
```

The cron will automatically deploy with your worker.

## Step 8: Configure Fireflies Webhook (Optional)

If you want real-time sync when meetings end:

1. Get your webhook URL:
   ```
   https://worker-alleato-fireflies-rag.[YOUR-SUBDOMAIN].workers.dev/webhook/fireflies
   ```

2. Configure in Fireflies:
   - Go to Fireflies Settings > Integrations > Webhooks
   - Add your webhook URL
   - Select "Meeting Completed" event
   - Save the webhook secret and set it as FIREFLIES_WEBHOOK_SECRET

## Monitoring

View logs:
```bash
# Tail logs in real-time
pnpm tail

# Or
npx wrangler tail
```

## Troubleshooting

### Common Issues:

1. **KV namespace not found**: Make sure you updated the IDs in wrangler.jsonc
2. **Database connection fails**: Verify Hyperdrive is configured correctly
3. **Supabase auth errors**: Check that secrets are set correctly
4. **Vector dimension mismatch**: Ensure you're using BGE base model (768 dimensions)

### Verify Configuration:

```bash
# Check your worker name and route
npx wrangler whoami

# List all your workers
npx wrangler list
```

## Production Checklist

- [ ] KV namespaces created and IDs updated
- [ ] All secrets configured (SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, FIREFLIES_API_KEY)
- [ ] Supabase database schema deployed
- [ ] Storage bucket "meetings" created
- [ ] Hyperdrive configured with connection string
- [ ] Worker deployed successfully
- [ ] Health endpoint responding
- [ ] Test sync working
- [ ] Logs monitored for errors