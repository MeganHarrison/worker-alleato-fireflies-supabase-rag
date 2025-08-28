#!/bin/bash

# Fireflies-Supabase RAG Worker Deployment Script

echo "🚀 Starting deployment of Fireflies-Supabase RAG Worker"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if command succeeded
check_status() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $1"
    else
        echo -e "${RED}✗${NC} $1 failed"
        exit 1
    fi
}

# Step 1: Check authentication
echo "📋 Checking Cloudflare authentication..."
npx wrangler whoami
check_status "Authentication check"
echo ""

# Step 2: Set secrets (if they don't exist)
echo "🔐 Setting up secrets..."
echo "Note: You'll be prompted for each secret if not already set"
echo ""

echo "Setting SUPABASE_SERVICE_KEY..."
npx wrangler secret put SUPABASE_SERVICE_KEY 2>/dev/null || echo "Secret may already exist"

echo "Setting SUPABASE_ANON_KEY..."
npx wrangler secret put SUPABASE_ANON_KEY 2>/dev/null || echo "Secret may already exist"

echo "Setting FIREFLIES_API_KEY..."
npx wrangler secret put FIREFLIES_API_KEY 2>/dev/null || echo "Secret may already exist"

echo ""
echo -e "${YELLOW}Optional:${NC} Set FIREFLIES_WEBHOOK_SECRET if using webhooks"
echo "Run: npx wrangler secret put FIREFLIES_WEBHOOK_SECRET"
echo ""

# Step 3: Deploy
echo "🚀 Deploying worker..."
npx wrangler deploy
check_status "Worker deployment"
echo ""

# Step 4: Get worker URL
echo "🌐 Your worker is deployed!"
echo ""
echo "Worker URL: https://worker-alleato-fireflies-rag.<your-subdomain>.workers.dev"
echo ""

# Step 5: Test endpoints
echo "📝 Test your deployment with these commands:"
echo ""
echo "# Health check:"
echo "curl https://worker-alleato-fireflies-rag.<your-subdomain>.workers.dev/api/health"
echo ""
echo "# Sync transcripts (limit 1 for testing):"
echo "curl -X POST https://worker-alleato-fireflies-rag.<your-subdomain>.workers.dev/api/sync \\"
echo "  -H \"Content-Type: application/json\" \\"
echo "  -d '{\"limit\": 1}'"
echo ""

# Step 6: Monitor
echo "📊 Monitor your worker:"
echo "npx wrangler tail"
echo ""

echo -e "${GREEN}✅ Deployment script completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Test the health endpoint"
echo "2. Run a test sync with limit=1"
echo "3. Monitor logs for any issues"
echo "4. Set up Fireflies webhook (optional)"