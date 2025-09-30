# Migration Guide: Documents to Document_Metadata

## Overview

This guide explains the migration from storing transcripts in the `documents` table to using `document_metadata` as the primary storage, with `documents` reserved exclusively for chunks with embeddings.

## Architecture Changes

### Before:
- `documents` table: Stored both full transcripts AND chunks (mixed usage)
- `document_metadata` table: Minimal metadata only

### After:
- `document_metadata` table: Full transcripts and all metadata (primary storage)
- `documents` table: Only chunks with vector embeddings (for search)
- `document_chunks` table: Alternative chunk storage (optional)

## Migration Steps

### 1. Run SQL Migration Script

Execute the migration script in your Supabase SQL editor:

```bash
# Run the refactor script
psql -f sql/16-refactor-document-tables.sql
```

Or copy and run the contents of `sql/16-refactor-document-tables.sql` in the Supabase SQL editor.

### 2. Deploy Updated Worker

The Fireflies worker has been updated to save to `document_metadata` instead of `documents`.

```bash
cd worker-alleato-fireflies-supabase-rag
npm run deploy
```

### 3. Migrate Existing Data (Optional)

If you have existing data in the `documents` table that needs to be migrated:

```sql
-- Migrate full documents to document_metadata
INSERT INTO document_metadata (
    id,
    title,
    source,
    category,
    content,
    participants,
    summary,
    action_items,
    bullet_points,
    fireflies_id,
    fireflies_link,
    date,
    duration_minutes,
    metadata,
    created_at,
    updated_at
)
SELECT
    COALESCE(fireflies_id, gen_random_uuid()::text) as id,
    title,
    source,
    category,
    content,
    participants,
    summary,
    action_items,
    bullet_points,
    fireflies_id,
    fireflies_link,
    date,
    COALESCE((metadata->>'duration_minutes')::int, 0) as duration_minutes,
    metadata,
    created_at,
    updated_at
FROM documents
WHERE
    source = 'fireflies'
    AND fireflies_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM document_metadata dm
        WHERE dm.fireflies_id = documents.fireflies_id
    );
```

### 4. Update Vectorizer Worker

If you have a separate vectorizer worker, update it to:
1. Read documents from `document_metadata` table
2. Save chunks to `documents` table with `document_metadata_id` reference

### 5. Update Insights Generation

The insights generator already reads from `document_metadata`, so no changes needed there.

## Key Changes in the Worker

### Database Service Changes

```typescript
// Before: Saving to documents table
INSERT INTO documents (title, source, content, ...)

// After: Saving to document_metadata table
INSERT INTO document_metadata (id, title, source, content, ...)
```

### Vector Search Changes

```typescript
// Before: Searching in document_chunks joined with documents
FROM document_chunks c
JOIN documents d ON c.document_id = d.id

// After: Searching in documents (chunks) joined with document_metadata
FROM documents c
JOIN document_metadata dm ON c.document_metadata_id = dm.id
```

### Analytics Changes

```typescript
// Before: Counting from documents table
SELECT COUNT(*) FROM documents WHERE source = 'fireflies'

// After: Counting from document_metadata table
SELECT COUNT(*) FROM document_metadata WHERE source = 'fireflies'
```

## Benefits of New Architecture

1. **Clear Separation of Concerns**
   - `document_metadata`: Full content and metadata
   - `documents`: Only chunks for vector search

2. **Better Performance**
   - Smaller `documents` table for faster vector searches
   - Full content in separate table reduces index overhead

3. **Simplified Insights Generation**
   - Insights generator reads directly from `document_metadata`
   - No need for data synchronization between tables

4. **Consistent Data Model**
   - Single source of truth for document content
   - Clear relationships between documents and chunks

## Testing

After migration, test the following:

1. **New Document Ingestion**
   ```bash
   curl -X POST https://your-worker.workers.dev/api/sync \
     -H "Content-Type: application/json" \
     -d '{"limit": 1}'
   ```

2. **Vector Search**
   ```bash
   curl -X POST https://your-worker.workers.dev/api/search \
     -H "Content-Type: application/json" \
     -d '{"query": "test query"}'
   ```

3. **Analytics**
   ```bash
   curl https://your-worker.workers.dev/api/analytics
   ```

## Rollback Plan

If you need to rollback:

1. Revert the worker code to previous version
2. Data remains intact in both tables
3. Re-run sync to populate any missing data

## Support

For issues or questions about this migration:
1. Check the logs: `npm run tail`
2. Verify database schema in Supabase
3. Test with a single document first