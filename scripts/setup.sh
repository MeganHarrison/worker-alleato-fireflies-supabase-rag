#!/bin/bash

# Setup script for Fireflies-Supabase RAG Worker
# This script helps set up the environment and deploy the worker

set -e

echo "🚀 Fireflies-Supabase RAG Worker Setup"
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if required tools are installed
check_requirements() {
    echo -e "${YELLOW}Checking requirements...${NC}"
    
    # Check for Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Node.js is not installed. Please install Node.js 18 or higher.${NC}"
        exit 1
    fi
    
    # Check for pnpm
    if ! command -v pnpm &> /dev/null; then
        echo -e "${YELLOW}pnpm is not installed. Installing...${NC}"
        npm install -g pnpm
    fi
    
    # Check for wrangler
    if ! command -v wrangler &> /dev/null; then
        echo -e "${YELLOW}Wrangler is not installed. It will be installed with dependencies.${NC}"
    fi
    
    echo -e "${GREEN}✓ Requirements check complete${NC}"
}

# Install dependencies
install_dependencies() {
    echo -e "${YELLOW}Installing dependencies...${NC}"
    pnpm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
}

# Create KV namespace
create_kv_namespace() {
    echo -e "${YELLOW}Creating KV namespace for caching...${NC}"
    
    # Create production KV namespace
    KV_ID=$(npx wrangler kv:namespace create "CACHE" --preview false | grep -oP 'id = "\K[^"]+')
    echo -e "${GREEN}✓ Production KV namespace created: ${KV_ID}${NC}"
    
    # Create preview KV namespace
    PREVIEW_KV_ID=$(npx wrangler kv:namespace create "CACHE" --preview | grep -oP 'id = "\K[^"]+')
    echo -e "${GREEN}✓ Preview KV namespace created: ${PREVIEW_KV_ID}${NC}"
    
    # Update wrangler.jsonc with IDs
    echo -e "${YELLOW}Please update wrangler.jsonc with:${NC}"
    echo "  KV Namespace ID: ${KV_ID}"
    echo "  KV Preview ID: ${PREVIEW_KV_ID}"
}

# Create Hyperdrive configuration
create_hyperdrive() {
    echo -e "${YELLOW}Setting up Hyperdrive for Supabase PostgreSQL...${NC}"
    echo -e "${YELLOW}Please provide your Supabase database connection string:${NC}"
    echo -e "Format: postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
    read -r CONNECTION_STRING
    
    if [ -z "$CONNECTION_STRING" ]; then
        echo -e "${RED}Connection string is required${NC}"
        return 1
    fi
    
    HYPERDRIVE_ID=$(npx wrangler hyperdrive create supabase-meetings --connection-string="$CONNECTION_STRING" | grep -oP 'id: \K[^"]+')
    
    echo -e "${GREEN}✓ Hyperdrive created: ${HYPERDRIVE_ID}${NC}"
    echo -e "${YELLOW}Please update wrangler.jsonc with Hyperdrive ID: ${HYPERDRIVE_ID}${NC}"
}

# Set secrets
set_secrets() {
    echo -e "${YELLOW}Setting up secret environment variables...${NC}"
    
    # Supabase Anon Key
    echo -e "${YELLOW}Enter your Supabase Anon Key:${NC}"
    read -rs SUPABASE_ANON_KEY
    echo "$SUPABASE_ANON_KEY" | npx wrangler secret put SUPABASE_ANON_KEY
    echo -e "${GREEN}✓ SUPABASE_ANON_KEY set${NC}"
    
    # Supabase Service Key
    echo -e "${YELLOW}Enter your Supabase Service Role Key:${NC}"
    read -rs SUPABASE_SERVICE_KEY
    echo "$SUPABASE_SERVICE_KEY" | npx wrangler secret put SUPABASE_SERVICE_KEY
    echo -e "${GREEN}✓ SUPABASE_SERVICE_KEY set${NC}"
    
    # Fireflies API Key
    echo -e "${YELLOW}Enter your Fireflies API Key:${NC}"
    read -rs FIREFLIES_API_KEY
    echo "$FIREFLIES_API_KEY" | npx wrangler secret put FIREFLIES_API_KEY
    echo -e "${GREEN}✓ FIREFLIES_API_KEY set${NC}"
    
    # Optional: Webhook Secret
    echo -e "${YELLOW}Enter Fireflies Webhook Secret (optional, press Enter to skip):${NC}"
    read -rs FIREFLIES_WEBHOOK_SECRET
    if [ ! -z "$FIREFLIES_WEBHOOK_SECRET" ]; then
        echo "$FIREFLIES_WEBHOOK_SECRET" | npx wrangler secret put FIREFLIES_WEBHOOK_SECRET
        echo -e "${GREEN}✓ FIREFLIES_WEBHOOK_SECRET set${NC}"
    fi
}

# Create Supabase storage bucket
create_storage_bucket() {
    echo -e "${YELLOW}Creating Supabase storage bucket...${NC}"
    echo -e "${YELLOW}Please run the following SQL in your Supabase SQL Editor:${NC}"
    echo ""
    cat << 'EOF'
-- Create storage bucket for meeting transcripts
INSERT INTO storage.buckets (id, name, public) 
VALUES ('meetings', 'meetings', true)
ON CONFLICT (id) DO NOTHING;
EOF
    echo ""
    echo -e "${YELLOW}Press Enter when you've created the bucket...${NC}"
    read
}

# Run database migrations
run_migrations() {
    echo -e "${YELLOW}Setting up database schema...${NC}"
    echo -e "${YELLOW}Please run the contents of supabase-schema.sql in your Supabase SQL Editor${NC}"
    echo -e "${YELLOW}Press Enter when complete...${NC}"
    read
    echo -e "${GREEN}✓ Database schema created${NC}"
}

# Build TypeScript
build_typescript() {
    echo -e "${YELLOW}Building TypeScript...${NC}"
    npx tsc --noEmit
    echo -e "${GREEN}✓ TypeScript build complete${NC}"
}

# Deploy worker
deploy_worker() {
    echo -e "${YELLOW}Deploying worker to Cloudflare...${NC}"
    npx wrangler deploy
    echo -e "${GREEN}✓ Worker deployed successfully!${NC}"
}

# Main setup flow
main() {
    echo ""
    check_requirements
    echo ""
    install_dependencies
    echo ""
    
    echo -e "${YELLOW}Would you like to create KV namespace? (y/n)${NC}"
    read -r CREATE_KV
    if [ "$CREATE_KV" = "y" ]; then
        create_kv_namespace
    fi
    echo ""
    
    echo -e "${YELLOW}Would you like to create Hyperdrive configuration? (y/n)${NC}"
    read -r CREATE_HD
    if [ "$CREATE_HD" = "y" ]; then
        create_hyperdrive
    fi
    echo ""
    
    echo -e "${YELLOW}Would you like to set secret environment variables? (y/n)${NC}"
    read -r SET_SECRETS
    if [ "$SET_SECRETS" = "y" ]; then
        set_secrets
    fi
    echo ""
    
    echo -e "${YELLOW}Have you created the Supabase project and enabled pgvector? (y/n)${NC}"
    read -r SUPABASE_READY
    if [ "$SUPABASE_READY" = "y" ]; then
        create_storage_bucket
        run_migrations
    else
        echo -e "${YELLOW}Please create a Supabase project and enable pgvector first.${NC}"
        echo -e "Run: CREATE EXTENSION IF NOT EXISTS vector;"
    fi
    echo ""
    
    echo -e "${YELLOW}Would you like to build and deploy the worker? (y/n)${NC}"
    read -r DEPLOY
    if [ "$DEPLOY" = "y" ]; then
        build_typescript
        deploy_worker
    fi
    
    echo ""
    echo -e "${GREEN}🎉 Setup complete!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Update wrangler.jsonc with your IDs if not already done"
    echo "2. Configure webhook in Fireflies.ai dashboard"
    echo "3. Test the API endpoints"
    echo ""
    echo "API Endpoints:"
    echo "  POST /api/sync       - Sync transcripts"
    echo "  POST /api/search     - Semantic search"
    echo "  GET  /api/analytics  - View analytics"
    echo "  GET  /api/health     - Health check"
}

# Run main function
main