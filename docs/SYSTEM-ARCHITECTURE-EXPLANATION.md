# PM RAG Fireflies Ingest - Complete System Architecture

## Overview

The PM RAG Fireflies Ingest system is a two-part architecture that automatically syncs meeting transcripts from Fireflies.ai and makes them searchable through vector embeddings. Here's exactly what happens and where data is stored.

## System Components

### 1. **PM RAG Fireflies Ingest Worker** (This System)
- **URL**: https://worker-alleato-fireflies-rag.megan-d14.workers.dev
- **Purpose**: Fetches transcripts from Fireflies, stores in database, triggers vectorization
- **Schedule**: Currently daily at 2 AM UTC (can be changed to every 30 minutes)

### 2. **PM RAG Vectorize Worker** (Separate System)
- **URL**: https://pm-rag-vectorize-production.megan-d14.workers.dev
- **Purpose**: Chunks text, generates OpenAI embeddings, stores vectors for search

## Data Flow - Step by Step

### Step 1: Fireflies Sync Trigger
The sync can be triggered in 3 ways:
1. **Scheduled Cron**: Runs automatically (currently daily at 2 AM UTC)
2. **Manual API Call**: POST to `/api/sync`
3. **Webhook**: When Fireflies meeting completes (if configured)

### Step 2: Fetch from Fireflies
```javascript
// The system calls Fireflies GraphQL API
await fireflies.getTranscripts(limit: 25)
// Returns: transcript IDs, titles, dates, participants
```

### Step 3: Process Each Transcript
For each transcript, the system:

1. **Fetches Full Content**:
   ```javascript
   const transcript = await fireflies.getTranscriptById(id)
   // Gets: full text, sentences, speakers, timestamps, action items, keywords
   ```

2. **Formats as Markdown**:
   ```markdown
   # Meeting Title
   Date: 2025-09-08
   Participants: John, Jane, Bob
   
   ## Summary
   [Overview text]
   
   ## Action Items
   - [ ] Task 1
   - [ ] Task 2
   
   ## Full Transcript
   John: Let's discuss the project...
   Jane: I agree, we should...
   ```

3. **Uploads to Supabase Storage**:
   - **Bucket**: `meetings`
   - **Path**: `meetings/[transcript-id].md`
   - **Access**: Public URL for reading

### Step 4: Database Storage

The system stores data in **TWO DIFFERENT TABLES** depending on configuration:

#### Option A: `meetings` Table (Dedicated RAG System)
```sql
INSERT INTO meetings (
  id,                    -- Fireflies transcript ID
  transcript_id,         -- Same as ID
  title,                 -- Meeting title
  date,                  -- Meeting date/time
  duration_minutes,      -- Length in minutes
  participants,          -- Array of names
  speaker_count,         -- Number of speakers
  category,              -- 'general' or specific category
  tags,                  -- Keywords array
  summary,               -- JSON with overview and action items
  transcript_url,        -- Link to Fireflies
  storage_bucket_path,   -- Path in Supabase Storage
  processing_status,     -- 'pending' → 'processing' → 'completed'
  raw_metadata           -- Full Fireflies metadata as JSON
)
```

#### Option B: `documents` Table (Main Application)
If integrated with the main app, it stores in the existing `documents` table:
```sql
INSERT INTO documents (
  title,                 -- Meeting title
  content,               -- Full markdown transcript
  source,                -- 'fireflies'
  summary,               -- Overview text
  action_items,          -- Array of tasks
  bullet_points,         -- Key points
  participants,          -- Array of attendees
  fireflies_id,          -- Fireflies transcript ID
  metadata: {
    meeting_date,
    duration_minutes,
    host_email,
    meeting_link,
    keywords,
    sync_timestamp
  }
)
```

### Step 5: Trigger Vectorization

After storing the meeting/document, the system calls the vectorize worker:

```javascript
// Sends to pm-rag-vectorize worker
POST https://pm-rag-vectorize-production.megan-d14.workers.dev/process
{
  "meetingId": "abc123"  // or documentId
}
```

### Step 6: Vectorization Process (Handled by Vectorize Worker)

The vectorize worker then:

1. **Retrieves the Document**:
   - Fetches from `meetings` or `documents` table
   - Downloads markdown from Supabase Storage

2. **Chunks the Text**:
   ```javascript
   // Speaker-aware chunking
   {
     maxChunkSize: 500,     // words
     overlap: 50,           // words
     bySpeaker: true        // group by speaker
   }
   ```

3. **Generates Embeddings**:
   - Uses OpenAI's `text-embedding-3-small` or `text-embedding-3-large`
   - Creates 768 or 1536-dimensional vectors
   - Caches embeddings to reduce API calls

4. **Stores Vectors**:
   ```sql
   INSERT INTO meeting_chunks (
     meeting_id,           -- Reference to meetings table
     chunk_index,          -- Order in document
     content,              -- Chunk text
     speaker_info,         -- Who said it
     start_timestamp,      -- When in meeting
     embedding             -- Vector array
   )
   ```

   Or if using documents table:
   ```sql
   INSERT INTO document_chunks (
     document_id,          -- Reference to documents table
     chunk_index,
     content,
     embedding
   )
   ```

### Step 7: Enable Search

Once vectorized, the content is searchable:

```sql
-- Find similar chunks using pgvector
SELECT * FROM meeting_chunks
WHERE 1 - (embedding <=> query_embedding) > 0.7
ORDER BY similarity DESC
LIMIT 10
```

## Current Database Structure

Based on the code analysis, the system uses **BOTH** approaches:

### 1. Dedicated `meetings` and `meeting_chunks` tables
- Used by the PM RAG Fireflies Ingest worker
- Optimized for meeting-specific metadata
- Includes speaker tracking and timestamps

### 2. General `documents` table
- Used by the manual sync scripts in the main app
- Stores all types of documents (meetings, PDFs, etc.)
- More generic structure

## Data Storage Summary

| Data Type | Storage Location | Purpose |
|-----------|-----------------|---------|
| **Raw Transcript** | Fireflies.ai | Source of truth |
| **Markdown File** | Supabase Storage (`meetings/`) | Human-readable format |
| **Meeting Metadata** | `meetings` or `documents` table | Searchable fields |
| **Text Chunks** | `meeting_chunks` or `document_chunks` | Vectorized segments |
| **Embeddings** | `embedding` column (pgvector) | Semantic search |
| **Processing Status** | `processing_status` column | Track vectorization |

## Automatic Sync Configuration

### Current Setup (Daily)
```json
"triggers": {
  "crons": ["0 2 * * *"]  // 2 AM UTC daily
}
```

### To Change to 30 Minutes
```json
"triggers": {
  "crons": ["*/30 * * * *"]  // Every 30 minutes
}
```

Then redeploy:
```bash
cd monorepo-agents/pm-rag-fireflies-ingest
npx wrangler deploy
```

## Processing Flow Status

1. **Fetched from Fireflies** → Status: N/A (not stored yet)
2. **Stored in Database** → Status: `pending`
3. **Vectorization Triggered** → Status: `processing`
4. **Chunks & Embeddings Created** → Status: `completed`
5. **Ready for Search** → Queryable via vector similarity

## API Endpoints

### Ingest Worker (Fireflies)
- `GET /api/health` - Check system health
- `POST /api/sync` - Manual sync trigger
- `POST /api/process` - Process single transcript
- `GET /api/analytics` - System statistics

### Vectorize Worker
- `GET /health` - Check health
- `POST /vectorize` - Process document into chunks
- `POST /search` - Semantic search
- `POST /embed` - Generate embedding for text

## Key Configuration Variables

### Fireflies Ingest Worker
- `VECTORIZE_WORKER_URL`: URL of the vectorize worker
- `WORKER_AUTH_TOKEN`: Bearer token for authentication
- `SYNC_BATCH_SIZE`: How many transcripts per sync (default: 25)
- `FIREFLIES_API_KEY`: Your Fireflies API key
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_KEY`: Service role key

### Vectorize Worker
- `OPENAI_API_KEY`: For generating embeddings
- `CHUNK_SIZE`: Words per chunk (default: 500)
- `CHUNK_OVERLAP`: Overlap between chunks (default: 50)
- `EMBEDDING_MODEL`: OpenAI model to use

## Integration Points

The system integrates with:
1. **Fireflies.ai** - Source of meeting transcripts
2. **Supabase PostgreSQL** - Stores metadata and vectors
3. **Supabase Storage** - Stores markdown files
4. **OpenAI API** - Generates embeddings
5. **pgvector** - Enables vector similarity search
6. **Cloudflare Workers** - Serverless execution environment

## Summary

The PM RAG Fireflies Ingest system:
1. **Fetches** meeting transcripts from Fireflies.ai
2. **Stores** them in Supabase (both database and storage)
3. **Triggers** vectorization to create searchable embeddings
4. **Enables** semantic search across all meeting content
5. **Runs** automatically on a schedule (configurable)

The data flows from Fireflies → Ingest Worker → Database/Storage → Vectorize Worker → Searchable Vectors, making all meeting content instantly searchable using natural language queries.