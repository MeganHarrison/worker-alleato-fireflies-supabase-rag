# Fireflies-Supabase RAG Worker

A production-ready Cloudflare Worker that integrates Fireflies.ai meeting transcripts with Supabase for storage and implements a Retrieval-Augmented Generation (RAG) system with vector search capabilities.

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Data Flow](#data-flow)
- [Chunking Strategies](#chunking-strategies)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Installation](#installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Usage Examples](#usage-examples)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Overview

This worker automatically syncs meeting transcripts from Fireflies.ai, processes them into searchable chunks with embeddings, and provides a semantic search API for retrieving relevant meeting content. It's designed for organizations that need to make their meeting history searchable and accessible.

### What This System Does

1. **Syncs** meeting transcripts from Fireflies.ai (scheduled or on-demand)
2. **Processes** transcripts into intelligent chunks preserving speaker context
3. **Generates** vector embeddings using Cloudflare AI (BGE base model)
4. **Stores** metadata in PostgreSQL and files in Supabase Storage
5. **Provides** semantic search API to find relevant meeting content
6. **Tracks** conversation threads and speaker patterns

### What This System Does NOT Do

- **No Chat Interface**: This is a retrieval system, not a chatbot
- **No Answer Generation**: Returns relevant chunks, doesn't generate answers
- **No Real-time Transcription**: Works with completed Fireflies transcripts only

## Features

### Core Capabilities

- 🔄 **Automatic Sync**: Daily scheduled sync at 2 AM UTC
- 🎯 **Smart Chunking**: Speaker-aware chunking with conversation threading
- 🔍 **Semantic Search**: Vector similarity search using pgvector
- 📊 **Analytics**: Usage statistics and system metrics
- 🪝 **Webhook Support**: Real-time sync when meetings complete
- 💾 **Dual Storage**: PostgreSQL for structured data, Supabase Storage for files
- ⚡ **Caching**: Embedding cache to reduce AI calls
- 🔒 **Rate Limiting**: Per-IP request throttling

### Technical Features

- **TypeScript**: Fully typed for reliability
- **Modular Architecture**: Separated services for maintainability
- **Connection Pooling**: Hyperdrive for PostgreSQL optimization
- **Batch Processing**: Parallel processing with configurable batch sizes
- **Error Resilience**: Continues processing even with individual failures
- **Structured Logging**: Context-aware logging with levels

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Fireflies.ai   │────▶│ Cloudflare Worker│────▶│    Supabase     │
│   (GraphQL)     │     │                  │     │   PostgreSQL    │
└─────────────────┘     │   - Fetch        │     │   + Storage     │
                        │   - Process      │     └─────────────────┘
                        │   - Chunk        │              │
                        │   - Vectorize    │              │
                        └──────────────────┘              │
                                │                         │
                                ▼                         ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Cloudflare AI   │     │  Vector Search  │
                        │  (Embeddings)    │     │   (pgvector)    │
                        └──────────────────┘     └─────────────────┘
```

## Data Flow

### 1. Sync Flow
```
Fireflies API → Transcript Fetch → Metadata Extraction → Storage Upload
                                          ↓
                                   Chunking Strategy
                                          ↓
                                   Embedding Generation
                                          ↓
                                   Database Storage
```

### 2. Search Flow
```
Search Query → Generate Embedding → Vector Similarity Search → Return Results
                                           ↓
                                   Apply Filters (date, dept, etc.)
                                           ↓
                                   Rank by Relevance
```

## Chunking Strategies

### Speaker-Based Chunking (Default)

The system uses intelligent chunking that preserves conversation context:

```typescript
{
  maxChunkSize: 500,      // Maximum words per chunk
  overlap: 50,            // Words overlap between chunks
  bySpeaker: true,        // Group by speaker changes
}
```

**Features:**
- **Speaker Grouping**: Keeps speaker turns together
- **Conversation Threading**: Detects related discussion threads
- **Temporal Context**: Preserves timestamps for each chunk
- **Overlap**: Maintains context between chunk boundaries

**Example Chunk:**
```json
{
  "text": "Let me explain the quarterly results...",
  "speaker": "John Smith",
  "startTime": 120.5,
  "endTime": 145.3,
  "chunkIndex": 3,
  "conversationThread": "thread_001"
}
```

### Simple Text Chunking (Alternative)

For transcripts without speaker information:
- Fixed-size chunks based on word count
- Consistent overlap for context preservation
- No speaker or timing metadata

## API Endpoints

### Health Check
```http
GET /api/health

Response:
{
  "status": "healthy",
  "timestamp": "2025-08-28T02:30:00Z",
  "version": "2.0.0"
}
```

### Sync Transcripts
```http
POST /api/sync
Content-Type: application/json

{
  "limit": 10,              // Optional: Max transcripts to sync
  "startDate": "2025-08-01", // Optional: Start date filter
  "endDate": "2025-08-28"    // Optional: End date filter
}

Response:
{
  "success": true,
  "processed": 8,
  "failed": 2,
  "errors": [...]
}
```

### Semantic Search
```http
POST /api/search
Content-Type: application/json

{
  "query": "What were the action items from the product meeting?",
  "options": {
    "limit": 10,           // Max results (default: 10)
    "threshold": 0.7,      // Similarity threshold (0-1)
    "department": "Product", // Filter by department
    "project": "Mobile App", // Filter by project
    "startDate": "2025-08-01", // Date range filter
    "endDate": "2025-08-28"
  }
}

Response:
{
  "results": [
    {
      "chunkId": 123,
      "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",
      "text": "The action items are: 1) Complete the design review...",
      "speaker": "Jane Doe",
      "similarity": 0.89,
      "meetingTitle": "Product Planning Q3",
      "meetingDate": "2025-08-15T14:00:00Z",
      "department": "Product",
      "fileUrl": "https://...supabase.co/storage/v1/object/public/meetings/..."
    }
  ]
}
```

### Analytics
```http
GET /api/analytics

Response:
{
  "totalMeetings": 150,
  "totalChunks": 4500,
  "averageChunksPerMeeting": 30,
  "departments": ["Engineering", "Product", "Sales"],
  "lastSync": "2025-08-28T02:00:00Z",
  "storageUsed": "125MB"
}
```

### Process Single Transcript
```http
POST /api/process
Content-Type: application/json

{
  "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W"
}

Response:
{
  "success": true,
  "chunksCreated": 45,
  "fileUrl": "https://...supabase.co/storage/v1/object/public/meetings/..."
}
```

### Webhook (Fireflies)
```http
POST /webhook/fireflies
Content-Type: application/json
X-Fireflies-Signature: [HMAC signature]

{
  "event": "meeting.completed",
  "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",
  ...
}
```

## Database Schema

### `meetings` Table
Stores meeting metadata and summary information:

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Fireflies transcript ID (Primary Key) |
| title | TEXT | Meeting title |
| date | TIMESTAMP | Meeting date and time |
| duration | INTEGER | Duration in seconds |
| participants | TEXT[] | Array of participant names |
| speaker_count | INTEGER | Number of unique speakers |
| meeting_type | TEXT | Type of meeting (standup, review, etc.) |
| department | TEXT | Department (for filtering) |
| project | TEXT | Project name (for filtering) |
| keywords | TEXT[] | Array of keywords from summary |
| action_items | TEXT[] | Array of action items |
| file_url | TEXT | URL to markdown file in Storage |

### `meetings_chunks` Table
Stores vectorized transcript chunks:

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Auto-incrementing ID (Primary Key) |
| transcript_id | TEXT | Foreign key to meetings.id |
| chunk_index | INTEGER | Order of chunk in transcript |
| text | TEXT | Chunk text content |
| speaker | TEXT | Speaker name (if available) |
| start_time | NUMERIC | Start timestamp in seconds |
| end_time | NUMERIC | End timestamp in seconds |
| embedding | vector(768) | 768-dimensional embedding vector |
| conversation_thread | TEXT | Thread identifier for related chunks |

### Indexes
- **IVFFlat index** on embeddings for fast similarity search
- **B-tree indexes** on department, project, date for filtering
- **Foreign key index** for efficient joins

## Installation

### Prerequisites

1. **Cloudflare Account** with Workers enabled
2. **Supabase Project** with:
   - pgvector extension enabled
   - Storage bucket named "meetings"
3. **Fireflies.ai API Key**
4. **Node.js 18+** and **pnpm** installed locally

### Setup Steps

1. **Clone the repository**
```bash
git clone [repository-url]
cd worker-alleato-fireflies-supabase-rag
```

2. **Install dependencies**
```bash
pnpm install
```

3. **Configure environment**
```bash
cp .env.example .env.local
# Edit .env.local with your values
```

4. **Set up database**
```bash
# Run the schema in Supabase SQL Editor
psql -h [host] -U postgres -d postgres -f supabase-schema.sql
```

5. **Create KV namespace**
```bash
npx wrangler kv namespace create CACHE
# Copy the ID to wrangler.jsonc
```

## Configuration

### Required Secrets
Set these using `npx wrangler secret put [NAME]`:

- `SUPABASE_SERVICE_KEY` - Service role key for admin operations
- `SUPABASE_ANON_KEY` - Anonymous key for public operations
- `FIREFLIES_API_KEY` - Your Fireflies API key
- `FIREFLIES_WEBHOOK_SECRET` - (Optional) For webhook verification

### Environment Variables (wrangler.jsonc)

```json
{
  "vars": {
    "SUPABASE_URL": "https://[project].supabase.co",
    "RATE_LIMIT_REQUESTS": 100,
    "RATE_LIMIT_WINDOW": 60,
    "SYNC_BATCH_SIZE": 25,
    "VECTOR_CACHE_TTL": 3600
  }
}
```

### Hyperdrive Configuration

```bash
# Create Hyperdrive config
npx wrangler hyperdrive create my-hyperdrive \
  --connection-string="postgresql://..."

# Update ID in wrangler.jsonc
```

## Deployment

### Quick Deploy
```bash
# Using the provided script
./deploy.sh

# Or manually
npx wrangler deploy
```

### Production Checklist
- ✅ All secrets configured
- ✅ Database schema deployed
- ✅ Storage bucket created
- ✅ KV namespace created
- ✅ Hyperdrive configured
- ✅ Tested locally with `pnpm dev`

## Usage Examples

### Search for Action Items
```javascript
const response = await fetch('https://your-worker.workers.dev/api/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'action items mobile app launch',
    options: {
      department: 'Product',
      threshold: 0.8
    }
  })
});
```

### Sync Recent Meetings
```javascript
const response = await fetch('https://your-worker.workers.dev/api/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    limit: 50,
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  })
});
```

### Get Analytics
```javascript
const response = await fetch('https://your-worker.workers.dev/api/analytics');
const analytics = await response.json();
console.log(`Total meetings: ${analytics.totalMeetings}`);
```

## Monitoring

### View Logs
```bash
# Real-time logs
npx wrangler tail

# Or using pnpm
pnpm tail
```

### Log Levels
- `ERROR` - Critical issues requiring attention
- `WARN` - Non-critical issues or degraded performance
- `INFO` - Important events (sync complete, etc.)
- `DEBUG` - Detailed debugging information

### Metrics to Monitor
- Sync success/failure rates
- Average processing time per transcript
- Embedding cache hit rate
- Vector search response times
- Storage usage growth

## Troubleshooting

### Common Issues

#### 1. Vector Dimension Mismatch
**Error**: "expected 768 dimensions, got 384"
**Solution**: Ensure you're using BGE base model in Cloudflare AI

#### 2. Database Connection Failed
**Error**: "connection attempt failed"
**Solution**: Check Hyperdrive configuration and connection string

#### 3. Rate Limit TTL Error
**Error**: "Invalid expiration_ttl of 51"
**Solution**: Already fixed in code - minimum TTL is 60 seconds

#### 4. Action Items Processing Error
**Error**: "forEach is not a function"
**Solution**: Already fixed - properly checks if action_items is an array

#### 5. Large Transcript Timeout
**Solution**: Reduce `SYNC_BATCH_SIZE` or increase chunk size

### Debug Mode

Enable debug logging:
```typescript
const logger = new Logger('DEBUG'); // Set in index.ts
```

### Testing Individual Components

```bash
# Test health endpoint
curl https://your-worker.workers.dev/api/health

# Test with single transcript
curl -X POST https://your-worker.workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 1}'
```

## Performance Optimization

### Current Optimizations
- **Connection Pooling**: Limited to 5 connections (Workers limit is 6)
- **Batch Processing**: Embeddings processed in batches of 10
- **Caching**: Vector embeddings cached for 1 hour
- **IVFFlat Index**: 100 lists for optimal search performance
- **Parallel Processing**: Async operations with Promise.all

### Scaling Considerations
- For >10,000 meetings: Increase IVFFlat lists to 200
- For >100,000 chunks: Consider partitioning by date
- Monitor embedding generation costs with high volume

## Security

- **Service Role Key**: Used only for admin operations
- **Row Level Security**: Can be enabled in Supabase
- **Webhook Verification**: HMAC signature validation
- **Rate Limiting**: Prevents abuse
- **CORS Headers**: Configured for browser access

## Contributing

See [CLAUDE.md](./CLAUDE.md) for AI assistant instructions and development guidelines.

## License

[Your License]

## Support

For issues or questions:
- Check the [Troubleshooting](#troubleshooting) section
- Review logs with `npx wrangler tail`
- Open an issue on GitHub