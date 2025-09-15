# PM RAG Fireflies Ingest - Automatic Sync Setup Guide

## Current Setup Status

**Worker URL:** https://worker-alleato-fireflies-rag.megan-d14.workers.dev  
**Health Status:** ✅ Healthy  
**Deployment Date:** September 4, 2025  
**Current Schedule:** Daily at 2:00 AM UTC (configured but needs update for 30-minute intervals)

## How Automatic Sync Works

The PM RAG Fireflies Ingest system is a Cloudflare Worker that automatically syncs meeting transcripts from Fireflies.ai to your Supabase database. It performs the following operations:

1. **Fetches** new transcripts from Fireflies.ai via GraphQL API
2. **Processes** transcripts into searchable chunks 
3. **Generates** vector embeddings using Cloudflare AI (BGE base model)
4. **Stores** data in Supabase (PostgreSQL with pgvector)
5. **Enables** semantic search across all meeting content

## Current Configuration

### Scheduled Trigger (Currently Daily)
The worker is currently configured to run once daily at 2:00 AM UTC. This is defined in `wrangler.jsonc`:

```json
"triggers": {
  "crons": ["0 2 * * *"]  // Daily at 2 AM UTC
}
```

## Setting Up 30-Minute Automatic Sync

To change the sync to run every 30 minutes, you need to update the cron schedule:

### Step 1: Update wrangler.jsonc

Edit the `wrangler.jsonc` file to change the cron schedule:

```json
"triggers": {
  "crons": ["*/30 * * * *"]  // Every 30 minutes
}
```

### Step 2: Deploy the Updated Configuration

```bash
cd monorepo-agents/pm-rag-fireflies-ingest
npx wrangler deploy
```

This will update the worker with the new schedule.

## Alternative Sync Methods

### 1. Manual Sync via API
You can trigger a sync manually at any time:

```bash
curl -X POST https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 50,
    "startDate": "2025-09-01"
  }'
```

### 2. Webhook-Based Real-Time Sync
For immediate sync when meetings end, configure a webhook in Fireflies:

1. Go to Fireflies Settings > Integrations > Webhooks
2. Add webhook URL: `https://worker-alleato-fireflies-rag.megan-d14.workers.dev/webhook/fireflies`
3. Select "Meeting Completed" event
4. Save the webhook secret and set it as a Cloudflare secret:
   ```bash
   npx wrangler secret put FIREFLIES_WEBHOOK_SECRET
   ```

### 3. External Scheduler
You can also use an external service to call the sync endpoint every 30 minutes:

- **Using cron-job.org** (free):
  1. Create account at https://cron-job.org
  2. Create new cron job
  3. URL: `https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync`
  4. Schedule: Every 30 minutes
  5. Method: POST
  6. Body: `{"limit": 25}`

- **Using GitHub Actions**:
  Create `.github/workflows/sync-fireflies.yml`:
  ```yaml
  name: Sync Fireflies Transcripts
  on:
    schedule:
      - cron: '*/30 * * * *'  # Every 30 minutes
    workflow_dispatch:  # Allow manual trigger
  
  jobs:
    sync:
      runs-on: ubuntu-latest
      steps:
        - name: Trigger Fireflies Sync
          run: |
            curl -X POST https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync \
              -H "Content-Type: application/json" \
              -d '{"limit": 25}'
  ```

## Monitoring the Automatic Sync

### View Real-Time Logs
```bash
cd monorepo-agents/pm-rag-fireflies-ingest
npx wrangler tail
```

### Check Sync Status
```bash
# Get analytics
curl https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/analytics

# Check last sync time and results
```

### Set Up Alerts
You can monitor the worker's health and set up alerts:

1. **Cloudflare Dashboard**:
   - Go to Workers & Pages > worker-alleato-fireflies-rag
   - View Analytics tab for request counts and errors
   - Set up email alerts for failures

2. **External Monitoring**:
   - Use services like UptimeRobot or Pingdom
   - Monitor: `https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/health`
   - Expected response: `{"status":"healthy"}`

## Rate Limiting and Performance

The worker has built-in protections:
- **Rate Limiting**: 100 requests per 60 seconds per IP
- **Batch Processing**: Processes 25 transcripts per sync by default
- **Caching**: Embeddings cached for 1 hour to reduce AI calls
- **Connection Pool**: Limited to 5 PostgreSQL connections

### Adjusting Batch Size
If processing too many or too few transcripts per sync:

1. Update in `wrangler.jsonc`:
   ```json
   "vars": {
     "SYNC_BATCH_SIZE": 10  // Reduce for 30-min intervals
   }
   ```

2. Redeploy:
   ```bash
   npx wrangler deploy
   ```

## Cost Considerations

Running every 30 minutes (48 times per day) will:
- **Cloudflare Workers**: Stay within free tier (100,000 requests/day)
- **Cloudflare AI**: Each sync uses ~10-50 AI calls (embeddings)
- **Supabase**: Minimal impact on database operations
- **Fireflies API**: Check your API rate limits

## Troubleshooting

### Common Issues with Frequent Syncs

1. **Rate Limiting from Fireflies**:
   - Solution: Reduce `SYNC_BATCH_SIZE` to 10 or less
   
2. **Database Connection Exhaustion**:
   - Solution: Already handled by Hyperdrive pooling (max 5 connections)
   
3. **Duplicate Processing**:
   - Solution: Worker checks for existing transcripts before processing

4. **Memory/Timeout Issues**:
   - Solution: Reduce batch size or chunk size

### Debug Commands
```bash
# Check if cron is registered
npx wrangler deployment list

# View worker configuration
cat wrangler.jsonc | grep -A 2 "triggers"

# Test sync endpoint manually
curl -X POST https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}' | jq .

# Monitor logs during scheduled run
npx wrangler tail --format pretty
```

## Quick Setup Summary

To enable 30-minute automatic sync RIGHT NOW:

```bash
# 1. Navigate to the project
cd /Users/meganharrison/Documents/github/alleato-project/alleato-ai-dashboard/monorepo-agents/pm-rag-fireflies-ingest

# 2. Update the cron schedule in wrangler.jsonc
# Change: "crons": ["0 2 * * *"]
# To:     "crons": ["*/30 * * * *"]

# 3. Deploy the changes
npx wrangler deploy

# 4. Verify deployment
curl https://worker-alleato-fireflies-rag.megan-d14.workers.dev/api/health

# 5. Monitor logs
npx wrangler tail
```

## Current Sync Status

Based on the deployment information:
- **Last Deployment**: September 4, 2025 at 12:55 PM UTC
- **Current Schedule**: Daily at 2:00 AM UTC
- **Worker Status**: ✅ Healthy and operational
- **Next Scheduled Run**: Tomorrow at 2:00 AM UTC (unless you update to 30-minute intervals)

## Next Steps

1. **Update to 30-minute schedule** by modifying wrangler.jsonc and redeploying
2. **Monitor initial runs** to ensure no rate limiting or performance issues
3. **Adjust batch size** if needed based on your meeting volume
4. **Consider webhook integration** for real-time updates in addition to scheduled sync

The system is fully deployed and operational. You just need to update the cron schedule and redeploy to enable 30-minute intervals.