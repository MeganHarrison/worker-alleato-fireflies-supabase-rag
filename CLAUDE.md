# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Fireflies Ingest Worker** - A Cloudflare Worker that integrates Fireflies.ai meeting transcripts with Supabase for storage. This is an **ingest-only worker** that handles transcript fetching, storage, and metadata management. Vector embeddings and search are delegated to a separate vectorizer worker.

**Version:** 2.0.0 (TypeScript implementation with Supabase)

**Current Status:** Production-ready ingest system with 487+ transcripts processed. Deployed at `https://worker-alleato-fireflies-rag.megan-d14.workers.dev`

## Tech Stack

- **Runtime:** Cloudflare Workers with TypeScript
- **Database:** Supabase PostgreSQL (uses `document_metadata` and `document_chunks` tables)
- **Storage:** Supabase Storage for transcript files (bucket: "meetings" - root folder)
- **Caching:** Cloudflare KV for rate limiting and flags
- **Connection:** Cloudflare Hyperdrive for PostgreSQL optimization
- **Dependencies:** 
  - `@supabase/supabase-js` for Supabase integration
  - `postgres` (v3.4.5+) for direct database queries

**Note:** Vector embeddings and search are handled by a separate vectorizer worker (not included in this repo).

## Architecture

### Architecture Overview

This worker is an **ingest-only system** with the following responsibilities:

**Owned by THIS worker:**
- ✅ Fireflies GraphQL client (fetch transcript lists and full transcripts)
- ✅ Supabase Storage upload of markdown transcripts to bucket root (with date-title naming)
- ✅ PostgreSQL insert/upsert of document_metadata records 
- ✅ Webhook verification (HMAC) + rate limiting + status endpoints
- ✅ Dispatch to separate Vectorizer Worker for embeddings

**Delegated to VECTORIZER WORKER:**
- → Transcript chunking (speaker-aware)
- → Embedding generation (OpenAI/Cloudflare AI)
- → Insert document_chunks rows with pgvector embeddings
- → Update processing status and metadata

### Core Implementation (`src/index.ts`)

Single-file implementation with embedded classes:

- **Logger**: Structured logging with context and levels
- **CacheService**: KV-based caching for flags and rate limiting
- **RateLimiter**: Per-IP sliding window rate limiting
- **FirefliesClient**: GraphQL API client for fetching transcripts
- **SupabaseStorageService**: File upload to `meetings` bucket root with `YYYY-MM-DD - Title.md` naming
- **DatabaseService**: Direct PostgreSQL operations via Hyperdrive (saves to `document_metadata` table)
- **WebhookHandler**: HMAC signature verification for Fireflies webhooks  
- **TranscriptProcessor**: Main orchestrator that coordinates all services

## Development Commands

```bash
# Install dependencies
pnpm install

# Development server (requires Hyperdrive connection string)
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://..." pnpm dev
# Alternative development commands
pnpm start      # Alias for pnpm dev

# Type checking and linting
pnpm lint       # Runs TypeScript type checking (tsc --noEmit)

# Testing
pnpm test       # Run Vitest tests
pnpm test:watch # Run tests in watch mode

# Generate TypeScript types for Cloudflare Workers
pnpm cf-typegen

# Deployment
pnpm deploy                    # Deploy to default environment
pnpm deploy:production         # Deploy to production environment
npx wrangler deploy            # Direct wrangler deployment

# View logs
pnpm tail                      # View real-time worker logs
npx wrangler tail              # Alternative log viewing

# Secrets management
npx wrangler secret put FIREFLIES_API_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY  
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put FIREFLIES_WEBHOOK_SECRET  # Optional
pnpm secrets:list              # List all secrets

# Setup commands for initial configuration
pnpm setup                     # Run interactive setup script
pnpm setup:kv                  # Create KV namespace
pnpm setup:hyperdrive          # Instructions for Hyperdrive setup

# Test scripts
node scripts/test-fireflies-fetch.js     # Test Fireflies API connection
node scripts/check-documents.js          # Check database documents count
node scripts/check-storage.js            # Check Supabase Storage files
node scripts/supabase-connection-test.js # Test Supabase connection
node scripts/test-supabase.js            # Test Supabase operations
```

## Configuration

### Required Environment Variables (Secrets)
- `FIREFLIES_API_KEY` - Fireflies.ai API key  
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `FIREFLIES_WEBHOOK_SECRET` (optional) - For webhook verification

### Configuration Variables (wrangler.jsonc)
- `SUPABASE_URL` - Your Supabase project URL (currently: lgveqfnpkxvzbnnwuled.supabase.co)
- `RATE_LIMIT_REQUESTS` - Max requests per window (default: 100)
- `RATE_LIMIT_WINDOW` - Rate limit window in seconds (default: 60)
- `SYNC_BATCH_SIZE` - Batch size for sync operations (default: 25)
- `VECTOR_CACHE_TTL` - Cache TTL in seconds (default: 3600)
- `ENABLE_REALTIME` - Enable real-time features (default: false)

### Required Bindings (from wrangler.jsonc)
- **Hyperdrive** (`HYPERDRIVE`) - ID: `81ca12eec05e4eeab6334050ae1a4dda`
- **KV Namespace** (`CACHE`) - ID: `246a76714a2a49d5852dd7831dd6d731`
- **AI** (`AI`) - Cloudflare AI binding (remote)

## Database Schema

The application uses PostgreSQL with pgvector extension. The schema is defined in `supabase-schema.sql`:

### Core Tables

- **document_metadata** table - Transcript metadata, participants, action items, content (THIS worker writes here)
  - Primary key: `id` (TEXT) - uses Fireflies transcript ID
  - Stores title, date, duration, participants, keywords, action_items
  - File URL pointing to Supabase Storage markdown file
  
- **document_chunks** table - Vectorized transcript chunks with embeddings (Vectorizer worker writes here)
  - Primary key: `id` (SERIAL)
  - Foreign key: `document_id` references `document_metadata(id)`
  - Contains 768-dimensional vector embeddings for BGE model
  - Includes speaker information and timing metadata

**Note:** This worker only writes to the `document_metadata` table. The `document_chunks` table is populated by the separate vectorizer worker.

### Important Schema Details
- pgvector extension must be enabled: `CREATE EXTENSION IF NOT EXISTS vector;`
- Embeddings are 768-dimensional vectors for BGE base model
- Unique constraint on (transcript_id, chunk_index) in chunks table
- Indexes optimized for date, department, project, and vector similarity queries

## API Endpoints

**Production URL:** `https://worker-alleato-fireflies-rag.megan-d14.workers.dev`

- `GET /api/health` - Health check with version info
- `POST /api/sync` - Sync recent transcripts from Fireflies (batch processing)
- `POST /api/process` - Process single transcript by Fireflies ID  
- `POST /api/search` - ⚠️ Requires vectorizer worker (delegates to separate service)
- `GET /api/analytics` - Usage analytics and database statistics
- `POST /webhook/fireflies` - Webhook endpoint for real-time Fireflies events

**Cron Schedule:** Automatic sync every 30 minutes (`*/30 * * * *`)

## Key Features

1. **Fireflies Integration**: GraphQL API client for fetching transcripts and metadata
2. **Smart Storage**: Files saved as `YYYY-MM-DD - Meeting Title.md` in Supabase Storage bucket root
3. **Rate Limiting**: Per-IP sliding window rate limiting (100 req/min)
4. **Batch Processing**: Parallel processing with configurable batch sizes (default: 25)  
5. **Structured Logging**: JSON logging with context and levels
6. **Webhook Security**: HMAC signature verification for Fireflies webhooks
7. **Scheduled Sync**: Automatic sync every 30 minutes
8. **Database Integration**: Direct PostgreSQL operations via Hyperdrive connection

## Testing

Tests use Vitest with Cloudflare Workers pool configuration. Test files in `test/` directory.

### Test Commands
```bash
# Run all tests
pnpm test

# Watch mode  
pnpm test:watch
```

### Test Structure
- `test/index.spec.ts` - Main worker tests (currently basic Hello World tests)
- `test/env.d.ts` - TypeScript environment definitions for tests
- `test/tsconfig.json` - Test-specific TypeScript configuration

### Manual Testing Scripts
Located in `scripts/` directory for integration testing:
- `test-fireflies-fetch.js` - Validates Fireflies GraphQL API connectivity
- `check-documents.js` - Verifies database document counts and recent entries
- `check-storage.js` - Confirms Supabase Storage file uploads
- `supabase-connection-test.js` - Tests direct Supabase connection
- `test-supabase.js` - Comprehensive Supabase operations testing

**Note:** The main test suite appears to be placeholder tests. Use the manual testing scripts for thorough integration validation.

## Deployment Checklist

1. **Supabase Setup**:
   - Enable pgvector extension: `CREATE EXTENSION IF NOT EXISTS vector;`
   - Run database schema from `supabase-schema.sql`
   - Create storage bucket named "meetings"

2. **Cloudflare Setup**:
   - Create KV namespace: `npx wrangler kv namespace create CACHE`
   - Create Hyperdrive config with Supabase connection string
   - Update wrangler.jsonc with IDs

3. **Secrets Configuration**:
   - Set all required secrets using `wrangler secret put`
   - Verify with `pnpm secrets:list`

4. **Deploy**:
   - Test locally: `pnpm dev`
   - Deploy: `pnpm deploy`
   - Monitor: `pnpm tail`

## Performance Considerations

- Connection pool limited to 5 (Workers limit is 6)
- Embeddings processed in batches of 10
- Vector cache TTL of 1 hour by default
- IVFFlat index with 100 lists for optimal search performance
- Async webhook processing with `waitUntil`

## Security Notes

- Service role key for admin operations only
- Row Level Security (RLS) policies configured
- Webhook signature verification available
- Rate limiting on all public endpoints
- CORS headers configured

## Troubleshooting

Common issues:
- **Vector dimension mismatch**: Ensure BGE base model (768 dims) matches schema
- **Connection limits**: Hyperdrive pool set to 5 connections max
- **Large transcripts**: Processed in chunks with configurable size
- **Auth errors**: Check Cloudflare login with `npx wrangler whoami`

## File Structure

```
├── src/
│   ├── index.ts          # Main worker with all processing logic
│   ├── types.ts          # TypeScript definitions
│   └── services/         # Modular services
│       ├── cache.ts      # Caching service
│       ├── logger.ts     # Logging service
│       └── rate-limiter.ts # Rate limiting
├── scripts/
│   └── setup.sh          # Interactive setup script
├── test/                 # Test files
├── README.md             # User documentation
├── CLAUDE.md            # AI assistant instructions
├── DEPLOYMENT.md        # Deployment guide
├── deploy.sh            # Deployment script
├── wrangler.jsonc       # Worker configuration
├── supabase-schema.sql  # Database schema
└── package.json         # Dependencies and scripts
```

## Data Processing Pipeline

### 1. Transcript Processing Flow

```
Fireflies Transcript
        ↓
Extract Metadata (title, date, participants, keywords, action items)
        ↓
Generate Markdown representation
        ↓
Upload to Supabase Storage
        ↓
Save metadata to `document_metadata` table
        ↓
Chunk transcript (speaker-aware or simple)
        ↓
Generate embeddings for each chunk
        ↓
Save chunks with embeddings to `document_chunks` table
```

### 2. Chunking Strategy Details

**Speaker-Based Chunking (Primary Strategy)**:
- Groups consecutive sentences by the same speaker
- Detects conversation threads based on temporal proximity
- Maintains context with configurable overlap
- Preserves speaker identity and timestamps

**Configuration**:
```typescript
{
  maxChunkSize: 500,    // words per chunk
  overlap: 50,          // words overlap
  bySpeaker: true       // group by speaker
}
```

**Conversation Thread Detection**:
- Analyzes speaker patterns and timing
- Groups related exchanges into threads
- Assigns thread IDs to chunks for context

### 3. Vector Search Implementation

**Embedding Generation**:
- Model: BGE base (768 dimensions)
- Batch size: 10 embeddings at a time
- Caching: SHA-256 hash-based cache with 1-hour TTL

**Search Process**:
```sql
-- Cosine similarity search with pgvector
SELECT
  chunk_id,
  text,
  1 - (embedding <=> query_embedding) as similarity
FROM document_chunks
WHERE 
  1 - (embedding <=> query_embedding) > threshold
  AND department = filter_department
ORDER BY similarity DESC
LIMIT 10
```

### 4. Database Tables Detail

**document_metadata table**:
- Primary storage for meeting metadata
- Arrays for participants, keywords, action_items
- Tracks department and project for filtering
- Links to file in Supabase Storage

**document_chunks table**:
- Stores individual text chunks
- 768-dimensional embedding vectors
- Speaker and timing information
- Thread identifiers for conversation context

**Indexes**:
- IVFFlat index with 100 lists for vector search
- B-tree indexes on filter columns (department, project, date)
- Unique constraint on (transcript_id, chunk_index)

## Current Status & Important Notes

### Production Deployment
- **Live URL**: `https://worker-alleato-fireflies-rag.megan-d14.workers.dev`
- **Database**: 487+ documents successfully ingested in document_metadata table
- **Storage**: 86+ transcript files in Supabase Storage bucket "meetings" (root folder)
- **Status**: Production-ready ingest system working correctly

### Current Limitations
1. **Ingest Only**: This worker does NOT handle vector embeddings or search
2. **Search Delegation**: `/api/search` endpoint requires separate vectorizer worker
3. **No Chat Interface**: Pure ingest system, not a chatbot
4. **Completed Transcripts Only**: Works with finished Fireflies transcripts

### Missing Components
- **Vectorizer Worker**: Separate service needed for chunking and embeddings
  - Expected to handle OpenAI/Cloudflare AI embeddings
  - Should populate `document_chunks` table
  - Must be deployed separately and configured via `VECTORIZE_WORKER_URL`

### File Naming Convention  
Storage files use format: `YYYY-MM-DD - Meeting Title.md`
- Example: `2025-09-15 - Goodwill Bloomington RFI Update.md`
- Old files still use Fireflies ID format until reprocessed

## Testing & Development

### Local Development Setup
```bash
# Required: Mock Hyperdrive connection for local dev
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://postgres:postgres@localhost:5432/postgres"

# Start development server
pnpm dev
```

### Testing Endpoints Locally
```bash
# Health check
curl http://localhost:8787/api/health

# Test sync with single transcript
curl -X POST http://localhost:8787/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}'

# Test search
curl -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "action items"}'
```

### Common Development Issues
1. **KV TTL Error**: Fixed - minimum TTL is 60 seconds
2. **Action Items Array**: Fixed - properly checks array type
3. **Local Postgres**: Use mock connection string for dev

## Code Architecture

### Main Implementation (`src/index.ts`)

The worker is implemented as a **single-file architecture** (~1091 lines) with embedded classes and services. This design choice optimizes for Cloudflare Workers deployment and reduces bundle size.

#### Core Classes (Embedded in index.ts)
Based on the file structure and documentation, the main classes include:

1. **Logger** - Structured logging with context and levels
2. **CacheService** - KV-based caching for flags and rate limiting  
3. **RateLimiter** - Per-IP sliding window rate limiting
4. **FirefliesClient** - GraphQL API client for fetching transcripts
5. **SupabaseStorageService** - File upload to `meetings/` bucket root
6. **DatabaseService** - Direct PostgreSQL operations via Hyperdrive
7. **WebhookHandler** - HMAC signature verification for Fireflies webhooks
8. **TranscriptProcessor** - Main orchestrator coordinating all services

#### Modular Services (`src/services/`)
Separate service modules for reusable functionality:
- `cache.ts` - Generic caching layer with KV
- `logger.ts` - Structured logging service  
- `rate-limiter.ts` - IP-based rate limiting logic

#### Type Definitions (`src/types.ts`)
Comprehensive TypeScript interfaces including:
- `Env` - Worker environment bindings and configuration
- `TranscriptMetadata` - Meeting metadata structure
- `FirefliesTranscript` - Fireflies API response shapes
- `TranscriptChunk` - Vector chunk representations
- `SearchOptions`, `SyncResult` - API operation types

### Architecture Principles

1. **Separation of Concerns**: Each class handles a specific domain (storage, database, webhooks)
2. **Dependency Injection**: Services are injected into the main processor
3. **Error Boundaries**: Structured error handling with logging context
4. **Async Processing**: All operations use modern async/await patterns
5. **Type Safety**: Full TypeScript coverage with strict type checking