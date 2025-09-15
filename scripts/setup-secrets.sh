#!/bin/bash

# Load environment variables from .env.local
if [ -f "../../.env.local" ]; then
    export $(cat ../../.env.local | grep -v '^#' | xargs)
else
    echo "❌ .env.local not found in parent directory"
    exit 1
fi

echo "🔐 Setting up Cloudflare Worker secrets..."
echo ""

# Set SUPABASE_SERVICE_KEY
echo "Setting SUPABASE_SERVICE_KEY..."
echo "$SUPABASE_SERVICE_ROLE_KEY" | npx wrangler secret put SUPABASE_SERVICE_KEY

# Set FIREFLIES_API_KEY
echo "Setting FIREFLIES_API_KEY..."
echo "$FIREFLIES_API_KEY" | npx wrangler secret put FIREFLIES_API_KEY

# Set VECTORIZE_WORKER_URL (pointing to the deployed vectorize worker)
echo "Setting VECTORIZE_WORKER_URL..."
echo "https://pm-rag-vectorize-production.megan-d14.workers.dev" | npx wrangler secret put VECTORIZE_WORKER_URL

# Set WORKER_AUTH_TOKEN (generate a secure token)
echo "Setting WORKER_AUTH_TOKEN..."
WORKER_TOKEN=$(openssl rand -hex 32)
echo "$WORKER_TOKEN" | npx wrangler secret put WORKER_AUTH_TOKEN
echo "Generated WORKER_AUTH_TOKEN: $WORKER_TOKEN"
echo "⚠️  Save this token - you'll need it for the vectorize worker"

# Set DATABASE_URL for direct Postgres connection
echo "Setting DATABASE_URL..."
echo "$DATABASE_URL" | npx wrangler secret put DATABASE_URL

echo ""
echo "✅ All secrets have been set!"
echo ""
echo "📋 Configured secrets:"
npx wrangler secret list