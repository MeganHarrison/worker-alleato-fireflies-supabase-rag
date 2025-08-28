# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Fireflies-Supabase RAG Worker** - A Cloudflare Worker application that integrates Fireflies.ai meeting transcripts with Supabase for storage and implements a production-ready RAG (Retrieval-Augmented Generation) system with vector search capabilities.

**Version:** 2.0.0 (TypeScript implementation with Supabase)

## Tech Stack

- **Runtime:** Cloudflare Workers with TypeScript
- **Database:** Supabase PostgreSQL with pgvector extension
- **Storage:** Supabase Storage for transcript files
- **AI/ML:** Cloudflare AI for embeddings (BGE base model - 768 dimensions)
- **Caching:** Cloudflare KV for embedding cache
- **Connection:** Cloudflare Hyperdrive for PostgreSQL optimization
- **Dependencies:** 
  - `@supabase/supabase-js` for Supabase integration
  - `postgres` (v3.4.5+) for database queries

## Architecture

### Core Services (`src/`)

1. **Main Worker** (`index.ts`):
   - HTTP request handling with CORS
   - Rate limiting per IP
   - Scheduled sync (cron: daily at 2 AM)
   - Webhook processing for Fireflies events
   - API endpoints for search, sync, analytics

2. **Service Modules** (`services/`):
   - `cache.ts` - KV-based caching with TTL and SHA-256 hashing
   - `rate-limiter.ts` - Request rate limiting with sliding window
   - `logger.ts` - Structured logging with levels and context

3. **Type Definitions** (`types.ts`):
   - Comprehensive TypeScript interfaces
   - Environment configuration types
   - API request/response types

### Core Classes

- **FirefliesClient**: GraphQL API integration with Fireflies.ai
- **ChunkingStrategy**: Intelligent text chunking with conversation threading
- **VectorizationService**: Embedding generation with caching
- **DatabaseService**: PostgreSQL operations via Hyperdrive
- **SupabaseStorageService**: File storage in Supabase buckets
- **TranscriptProcessor**: Orchestrates transcript processing pipeline
- **WebhookHandler**: Webhook signature verification and processing

## Development Commands

```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Run tests
pnpm test
pnpm test:watch

# Type checking
pnpm lint

# Generate Cloudflare types
pnpm cf-typegen

# Setup (interactive)
pnpm setup

# Deploy
pnpm deploy
pnpm deploy:production

# View logs
pnpm tail

# Manage secrets
pnpm secrets:list
npx wrangler secret put SECRET_NAME
```

## Configuration

### Required Environment Variables (Secrets)
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `SUPABASE_ANON_KEY` - Supabase anonymous key  
- `FIREFLIES_API_KEY` - Fireflies.ai API key
- `FIREFLIES_WEBHOOK_SECRET` (optional) - For webhook verification

### Configuration Variables (wrangler.jsonc)
- `SUPABASE_URL` - Your Supabase project URL
- `RATE_LIMIT_REQUESTS` - Max requests per window (default: 100)
- `RATE_LIMIT_WINDOW` - Rate limit window in seconds (default: 60)
- `SYNC_BATCH_SIZE` - Batch size for sync operations (default: 25)
- `VECTOR_CACHE_TTL` - Embedding cache TTL in seconds (default: 3600)

### Required Bindings
- **Hyperdrive** (`HYPERDRIVE`) - PostgreSQL connection optimization
- **KV Namespace** (`CACHE`) - For embedding and request caching
- **AI** (`AI`) - Cloudflare AI for embeddings

## Database Schema

The application uses PostgreSQL with pgvector extension:

- **meetings** table - Transcript metadata, keywords, action items
- **meetings_chunks** table - Vectorized transcript chunks with embeddings
- **meeting_search_view** - Convenience view for searching

Key indexes:
- IVFFlat index on embeddings for fast similarity search
- B-tree indexes on department, project, date for filtering

## API Endpoints

- `GET /api/health` - Health check with version info
- `POST /api/sync` - Sync transcripts from Fireflies (batch)
- `POST /api/process` - Process single transcript
- `POST /api/search` - Semantic search with filters
- `GET /api/analytics` - Usage analytics and statistics
- `POST /webhook/fireflies` - Webhook endpoint for Fireflies events

## Key Features

1. **Vector Search**: pgvector with cosine similarity, IVFFlat indexing
2. **Intelligent Caching**: SHA-256 based KV cache for embeddings
3. **Rate Limiting**: Per-IP sliding window rate limiting
4. **Conversation Threading**: Automatic detection of conversation threads
5. **Batch Processing**: Parallel processing with configurable batch sizes
6. **Structured Logging**: Context-aware logging with levels
7. **Webhook Security**: HMAC signature verification
8. **Scheduled Sync**: Automatic daily synchronization

## Testing

Tests use Vitest with Cloudflare Workers pool configuration. Test files in `test/` directory.

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch
```

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
Save metadata to `meetings` table
        ↓
Chunk transcript (speaker-aware or simple)
        ↓
Generate embeddings for each chunk
        ↓
Save chunks with embeddings to `meetings_chunks` table
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
FROM meetings_chunks
WHERE 
  1 - (embedding <=> query_embedding) > threshold
  AND department = filter_department
ORDER BY similarity DESC
LIMIT 10
```

### 4. Database Tables Detail

**meetings table**:
- Primary storage for meeting metadata
- Arrays for participants, keywords, action_items
- Tracks department and project for filtering
- Links to file in Supabase Storage

**meetings_chunks table**:
- Stores individual text chunks
- 768-dimensional embedding vectors
- Speaker and timing information
- Thread identifiers for conversation context

**Indexes**:
- IVFFlat index with 100 lists for vector search
- B-tree indexes on filter columns (department, project, date)
- Unique constraint on (transcript_id, chunk_index)

## Current Limitations & Future Enhancements

### Current Limitations
1. **No Chat Interface**: Returns chunks, not conversational responses
2. **No Answer Generation**: Pure retrieval, no LLM generation
3. **No Real-time Processing**: Works with completed transcripts only
4. **Fixed Embedding Model**: BGE base only (768 dims)

### Potential Enhancements
1. **Add Chat Generation**: 
   - Integrate with Claude/GPT for answer generation
   - Use retrieved chunks as context
   
2. **Improved Chunking**:
   - Semantic chunking based on topic changes
   - Dynamic chunk sizes based on content
   
3. **Enhanced Search**:
   - Hybrid search (keyword + semantic)
   - Re-ranking with cross-encoder
   
4. **Real-time Features**:
   - Webhook processing for immediate sync
   - Live transcript updates

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

## Code Organization

### Main Classes in index.ts

1. **FirefliesClient** (lines 57-161)
   - GraphQL queries to Fireflies API
   - Transcript fetching and formatting

2. **ChunkingStrategy** (lines 162-261)
   - Speaker-based chunking logic
   - Conversation thread detection

3. **VectorizationService** (lines 262-327)
   - Embedding generation with Cloudflare AI
   - Caching layer for embeddings

4. **DatabaseService** (lines 328-487)
   - PostgreSQL operations via Hyperdrive
   - Vector search implementation

5. **SupabaseStorageService** (lines 488-534)
   - File upload to Supabase Storage
   - Public URL generation

6. **TranscriptProcessor** (lines 665-761)
   - Orchestrates entire processing pipeline
   - Manages sync operations

7. **WebhookHandler** (lines 762-800)
   - Webhook signature verification
   - Event processing

### Service Modules

- **cache.ts**: Generic caching with KV
- **logger.ts**: Structured logging
- **rate-limiter.ts**: IP-based rate limiting