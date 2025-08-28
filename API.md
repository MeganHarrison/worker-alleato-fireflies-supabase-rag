# API Documentation

Complete API reference for the Fireflies-Supabase RAG Worker with examples and response schemas.

## Base URL

```
https://worker-alleato-fireflies-rag.[your-subdomain].workers.dev
```

## Authentication

Currently, the API uses IP-based rate limiting. No API keys are required for public endpoints.

**Rate Limits:**
- 100 requests per 60 seconds per IP address
- Rate limit headers included in all responses

## Response Headers

All responses include:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1693584000000
Access-Control-Allow-Origin: *
Content-Type: application/json
```

---

## Endpoints

### 1. Health Check

Check if the service is running and get version information.

**Request:**
```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-08-28T02:30:00.000Z",
  "version": "2.0.0"
}
```

**Status Codes:**
- `200`: Service is healthy
- `500`: Service is unhealthy

---

### 2. Sync Transcripts

Sync meeting transcripts from Fireflies.ai. Can be triggered manually or via cron schedule.

**Request:**
```http
POST /api/sync
Content-Type: application/json

{
  "limit": 10,                    // Optional: Max transcripts to sync (default: 50)
  "startDate": "2025-08-01",      // Optional: ISO date string
  "endDate": "2025-08-28",        // Optional: ISO date string
  "force": false                  // Optional: Re-process already synced transcripts
}
```

**Response:**
```json
{
  "success": true,
  "processed": 8,
  "failed": 2,
  "errors": [
    {
      "transcript_id": "01K374MAQ92EM6Z9BVXT12AT7W",
      "error": "Database connection failed"
    }
  ],
  "duration": 15234  // Processing time in milliseconds
}
```

**Status Codes:**
- `200`: Sync completed (may have partial failures)
- `400`: Invalid request parameters
- `429`: Rate limit exceeded
- `500`: Internal server error

**Example: Sync Last 7 Days**
```javascript
const response = await fetch('https://your-worker.workers.dev/api/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    limit: 100,
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  })
});
```

---

### 3. Semantic Search

Search for relevant meeting content using natural language queries.

**Request:**
```http
POST /api/search
Content-Type: application/json

{
  "query": "action items for mobile app",  // Required: Search query
  "options": {                            // Optional: Search filters
    "limit": 10,                          // Max results (default: 10, max: 100)
    "threshold": 0.7,                     // Similarity threshold 0-1 (default: 0.5)
    "department": "Engineering",          // Filter by department
    "project": "Mobile App",              // Filter by project
    "speaker": "John Doe",                // Filter by speaker
    "startDate": "2025-08-01",           // Date range start
    "endDate": "2025-08-28",             // Date range end
    "meetingType": "standup",            // Filter by meeting type
    "includeMetadata": true              // Include full meeting metadata
  }
}
```

**Response:**
```json
{
  "results": [
    {
      "chunkId": 456,
      "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",
      "text": "The main action items for the mobile app are: 1) Complete UI redesign by Friday, 2) Fix the login bug reported by QA...",
      "speaker": "Jane Smith",
      "startTime": 245.5,
      "endTime": 289.3,
      "similarity": 0.892,
      "conversationThread": "thread_002",
      "metadata": {
        "meetingTitle": "Mobile Team Standup",
        "meetingDate": "2025-08-15T14:00:00Z",
        "duration": 1800,
        "participants": ["Jane Smith", "John Doe", "Alice Johnson"],
        "department": "Engineering",
        "project": "Mobile App",
        "keywords": ["mobile", "UI", "bug fix", "release"],
        "fileUrl": "https://lgveqfnpkxvzbnnwuled.supabase.co/storage/v1/object/public/meetings/transcripts/01K374MAQ92EM6Z9BVXT12AT7W.md"
      }
    }
  ],
  "totalResults": 1,
  "queryEmbeddingCached": false,
  "searchDuration": 234  // milliseconds
}
```

**Status Codes:**
- `200`: Search completed successfully
- `400`: Missing or invalid query
- `429`: Rate limit exceeded
- `500`: Internal server error

**Example: Search with Filters**
```javascript
const response = await fetch('https://your-worker.workers.dev/api/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: "budget discussion",
    options: {
      department: "Finance",
      threshold: 0.8,
      limit: 5,
      startDate: "2025-08-01"
    }
  })
});
```

---

### 4. Process Single Transcript

Process a specific transcript by ID. Useful for reprocessing or testing.

**Request:**
```http
POST /api/process
Content-Type: application/json

{
  "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",  // Required
  "options": {                                    // Optional
    "maxChunkSize": 500,
    "overlap": 50,
    "bySpeaker": true,
    "force": false  // Reprocess even if already processed
  }
}
```

**Response:**
```json
{
  "success": true,
  "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",
  "chunksCreated": 42,
  "embeddingsGenerated": 42,
  "fileUrl": "https://lgveqfnpkxvzbnnwuled.supabase.co/storage/v1/object/public/meetings/transcripts/01K374MAQ92EM6Z9BVXT12AT7W.md",
  "metadata": {
    "title": "Weekly Team Sync",
    "date": "2025-08-28T15:00:00Z",
    "duration": 2700,
    "participants": ["John Doe", "Jane Smith"],
    "keywords": ["planning", "roadmap", "Q4"],
    "actionItems": ["Review PRD", "Schedule design review"]
  },
  "processingTime": 3456  // milliseconds
}
```

**Status Codes:**
- `200`: Processing completed successfully
- `400`: Invalid transcript ID
- `404`: Transcript not found in Fireflies
- `429`: Rate limit exceeded
- `500`: Processing error

---

### 5. Get Analytics

Get system statistics and usage analytics.

**Request:**
```http
GET /api/analytics
```

**Response:**
```json
{
  "meetings": {
    "total": 234,
    "lastWeek": 18,
    "lastMonth": 67,
    "byDepartment": {
      "Engineering": 89,
      "Product": 45,
      "Sales": 56,
      "Marketing": 44
    },
    "byMeetingType": {
      "standup": 120,
      "review": 45,
      "planning": 32,
      "other": 37
    }
  },
  "chunks": {
    "total": 8934,
    "averagePerMeeting": 38.2,
    "withSpeaker": 7823,
    "withThread": 5234
  },
  "storage": {
    "filesCount": 234,
    "totalSize": "458.3 MB",
    "averageFileSize": "1.96 MB"
  },
  "processing": {
    "lastSync": "2025-08-28T02:00:00Z",
    "lastSyncDuration": 45678,
    "lastSyncProcessed": 15,
    "lastSyncFailed": 2,
    "averageProcessingTime": 2345
  },
  "search": {
    "totalSearches": 1234,
    "averageResponseTime": 156,
    "cacheHitRate": 0.73
  },
  "system": {
    "version": "2.0.0",
    "uptime": 864000,
    "kvCacheEntries": 567
  }
}
```

**Status Codes:**
- `200`: Analytics retrieved successfully
- `429`: Rate limit exceeded
- `500`: Internal server error

---

### 6. Fireflies Webhook

Endpoint for receiving Fireflies webhook events. Requires webhook secret configuration.

**Request:**
```http
POST /webhook/fireflies
Content-Type: application/json
X-Fireflies-Signature: sha256=a1b2c3d4e5...

{
  "event": "meeting.completed",
  "timestamp": "2025-08-28T16:30:00Z",
  "data": {
    "transcriptId": "01K374MAQ92EM6Z9BVXT12AT7W",
    "meetingId": "meeting_123",
    "title": "Product Planning",
    "duration": 3600
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Webhook processed",
  "action": "transcript_queued_for_processing"
}
```

**Status Codes:**
- `200`: Webhook processed successfully
- `401`: Invalid signature
- `400`: Invalid webhook payload
- `500`: Processing error

**Webhook Events Supported:**
- `meeting.completed` - Triggered when meeting transcription is complete
- `meeting.updated` - Triggered when meeting is edited
- `meeting.deleted` - Triggered when meeting is deleted

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {
    // Additional error context
  }
}
```

**Common Error Codes:**
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `INVALID_REQUEST` - Malformed request body
- `TRANSCRIPT_NOT_FOUND` - Transcript ID doesn't exist
- `DATABASE_ERROR` - Database operation failed
- `EMBEDDING_ERROR` - Failed to generate embeddings
- `STORAGE_ERROR` - File storage operation failed

---

## Caching

The API implements several caching strategies:

1. **Embedding Cache**: Generated embeddings are cached for 1 hour
2. **Processed Transcript Cache**: Tracks processed transcripts to avoid reprocessing
3. **Search Result Cache**: Frequent queries are cached for 15 minutes

Cache headers:
```http
X-Cache-Status: HIT|MISS
X-Cache-Key: [sha256_hash]
```

---

## Webhooks Configuration

To set up webhooks in Fireflies:

1. Go to Fireflies Settings → Integrations → Webhooks
2. Add webhook URL: `https://your-worker.workers.dev/webhook/fireflies`
3. Select events to subscribe to
4. Copy the webhook secret
5. Set secret in worker: `npx wrangler secret put FIREFLIES_WEBHOOK_SECRET`

---

## Rate Limiting

Rate limits are applied per IP address:

- **Default**: 100 requests per 60 seconds
- **Search endpoint**: 50 requests per 60 seconds
- **Sync endpoint**: 10 requests per 60 seconds

When rate limited, the API returns:

```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "retryAfter": 45  // seconds
}
```

---

## Pagination

For endpoints that return lists, pagination is handled via limit/offset:

```json
{
  "limit": 20,    // Items per page
  "offset": 40    // Skip first 40 items
}
```

Note: The current implementation doesn't support pagination for search results. Consider implementing cursor-based pagination for large result sets.

---

## Testing

### cURL Examples

**Health Check:**
```bash
curl https://your-worker.workers.dev/api/health
```

**Search:**
```bash
curl -X POST https://your-worker.workers.dev/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "quarterly goals"}'
```

**Sync with Limit:**
```bash
curl -X POST https://your-worker.workers.dev/api/sync \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}'
```

### JavaScript/TypeScript Client Example

```typescript
class FirefliesRAGClient {
  constructor(private baseUrl: string) {}

  async search(query: string, options = {}) {
    const response = await fetch(`${this.baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, options })
    });
    
    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }
    
    return response.json();
  }

  async sync(options = {}) {
    const response = await fetch(`${this.baseUrl}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });
    
    return response.json();
  }

  async getAnalytics() {
    const response = await fetch(`${this.baseUrl}/api/analytics`);
    return response.json();
  }
}

// Usage
const client = new FirefliesRAGClient('https://your-worker.workers.dev');
const results = await client.search('action items from last week');
```