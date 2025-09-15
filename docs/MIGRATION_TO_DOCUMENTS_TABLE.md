# Migration: PM RAG Fireflies Ingest Worker - Using Documents Table

## Overview
Successfully migrated the PM RAG Fireflies Ingest worker from using the `meetings` table to the unified `documents` table. This aligns with the overall data architecture where all content types (meetings, documents, manuals, etc.) are stored in a single documents table.

## Changes Made

### 1. Database Schema Update
- Created migration to add `bullet_points` column to the documents table
- Added index on `bullet_points` for better query performance
- Updated the `meeting_documents` view to include the new field

### 2. GraphQL Query Updates
- Updated Fireflies GraphQL queries to fetch all summary fields:
  - `overview` - Main summary text
  - `action_items` - List of action items
  - `bullet_gist` - Bullet point summary (maps to `bullet_points` column)
  - `keywords` - Keywords extracted from the meeting

### 3. Data Mapping Updates
The following Fireflies data is now correctly mapped to documents table columns:

| Fireflies Field | Documents Table Column | Description |
|-----------------|------------------------|-------------|
| `id` | `fireflies_id` | Unique Fireflies meeting ID |
| `title` | `title` | Meeting title |
| `summary.overview` | `summary` | Main summary text |
| `summary.action_items` | `action_items` | Array of action items |
| `summary.bullet_gist` | `bullet_points` | Array of bullet points |
| `summary.keywords` | `keywords` | Array of keywords |
| `participants` | `participants` | Array of participant names |
| `date` | `meeting_date` | Meeting date/time |
| `duration` | `duration_minutes` | Meeting duration in minutes |
| N/A (generated) | `fireflies_link` | Generated as `https://app.fireflies.ai/view/{id}` |
| Formatted markdown | `content` | Full formatted markdown of the transcript |
| N/A (static) | `source` | Set to 'fireflies' |
| N/A (static) | `category` | Set to 'meeting' |

### 4. Code Updates

#### DatabaseService Changes
- Renamed `saveMeeting` method (kept name for compatibility but it now saves to documents)
- Updated INSERT statement to use documents table
- Added proper conflict handling on `fireflies_id`
- Generates Fireflies link automatically
- Stores full formatted markdown in `content` column

#### Vector Search Updates
- Updated to query `document_chunks` instead of `meeting_chunks`
- Updated joins to use `documents` table instead of `meetings`
- Updated field mappings for filters (e.g., `project_id` instead of `project`)
- Added support for new fields like `bullet_points` in search results

#### Analytics Updates
- All queries now filter by `source = 'fireflies'` to get only meeting documents
- Updated table references from `meetings` to `documents`
- Updated field references (e.g., `meeting_date` instead of `date`)
- Fixed keyword processing to handle array format directly

#### Vectorization Updates
- Changed from `meetingId` to `documentId` throughout
- Updated triggerVectorization method to send `documentId` parameter
- Updated logging to reference documentId

### 5. Markdown Formatting Enhancements
The `formatTranscriptAsMarkdown` method now includes:
- Summary section (from `overview` field)
- Key Points section (from `bullet_gist` field)
- Keywords section
- Action Items section
- Full transcript with speaker attribution

## Benefits

1. **Unified Data Model**: All content (meetings, documents, etc.) now in single table
2. **Better RAG Performance**: Single vector search across all content types
3. **Simplified Queries**: No need for complex joins between meetings and documents
4. **Extensibility**: Easy to add new content sources without schema changes
5. **Consistency**: Same data structure for all content types

## Migration SQL

To apply the bullet_points column to your database, run:

```sql
-- Add bullet_points column to documents table for Fireflies bullet_gist data
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS bullet_points TEXT[];

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_documents_bullet_points ON documents USING GIN(bullet_points);

-- Add computed column for bullet points count
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS bullet_points_count INTEGER GENERATED ALWAYS AS (
  CASE 
    WHEN bullet_points IS NULL THEN 0
    ELSE array_length(bullet_points, 1)
  END
) STORED;
```

## Testing

The worker has been validated with:
- TypeScript compilation check
- Wrangler dry-run deployment
- All references updated from meetings to documents table

## Next Steps

1. Run the migration SQL in your Supabase database
2. Deploy the updated worker to production
3. Update any vectorization worker to handle `documentId` instead of `meetingId`
4. Test with a few Fireflies webhooks to ensure data flows correctly
5. Verify vector search works with the new document structure

## Important Notes

- The worker maintains backward compatibility by keeping the method name `saveMeeting`
- The `fireflies_link` is automatically generated from the Fireflies ID
- All meeting-specific data is preserved in the documents table
- The worker filters by `source = 'fireflies'` to isolate meeting data in analytics