// Quick fix to use Supabase REST API instead of Hyperdrive
// This bypasses the "Tenant or user not found" error

import { createClient } from '@supabase/supabase-js';

export class SupabaseDatabase {
  private supabase: any;
  private logger: any;

  constructor(supabaseUrl: string, supabaseKey: string, logger: any) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.logger = logger;
  }

  async saveMeeting(metadata: any, fileUrl: string): Promise<void> {
    this.logger.debug('Saving meeting via Supabase', { meetingId: metadata.id });
    
    const summary = metadata.summary ? {
      keywords: metadata.summary.keywords || [],
      action_items: metadata.summary.action_items || []
    } : {};
    
    const { data, error } = await this.supabase
      .from('meetings')
      .upsert({
        id: metadata.id,
        transcript_id: metadata.id,
        title: metadata.title,
        date: metadata.date,
        duration_minutes: Math.round((metadata.duration || 0) / 60),
        participants: metadata.participants,
        speaker_count: metadata.speakerCount,
        category: metadata.meetingType || 'general',
        tags: metadata.summary?.keywords || [],
        summary: summary,
        transcript_url: fileUrl,
        storage_bucket_path: fileUrl,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      });

    if (error) {
      throw new Error(`Failed to save meeting: ${error.message}`);
    }
    
    this.logger.info('Meeting saved', { meetingId: metadata.id });
  }

  async saveChunks(transcriptId: string, chunks: any[]): Promise<void> {
    this.logger.debug('Saving chunks via Supabase', { 
      transcriptId, 
      chunkCount: chunks.length 
    });
    
    // Delete existing chunks
    await this.supabase
      .from('meeting_chunks')
      .delete()
      .eq('meeting_id', transcriptId);

    // Prepare chunks for insert
    const chunksToInsert = chunks.map(chunk => ({
      meeting_id: transcriptId,
      chunk_index: chunk.chunk_index,
      content: chunk.text,
      speaker_info: chunk.speaker ? {
        name: chunk.speaker,
        start_time: chunk.start_time,
        end_time: chunk.end_time
      } : null,
      start_timestamp: chunk.start_time,
      end_timestamp: chunk.end_time,
      embedding: chunk.embedding,
      metadata: {
        conversation_thread: chunk.conversation_thread
      },
      chunk_type: 'transcript',
      search_text: chunk.text
    }));

    // Insert in batches
    const batchSize = 10;
    for (let i = 0; i < chunksToInsert.length; i += batchSize) {
      const batch = chunksToInsert.slice(i, i + batchSize);
      const { error } = await this.supabase
        .from('meeting_chunks')
        .insert(batch);
      
      if (error) {
        this.logger.error('Failed to insert chunk batch', { error, batchIndex: i });
        throw new Error(`Failed to save chunks: ${error.message}`);
      }
    }
    
    this.logger.info('Chunks saved', { 
      transcriptId, 
      chunkCount: chunks.length 
    });
  }

  async vectorSearch(queryEmbedding: number[], options: any = {}): Promise<any[]> {
    const { limit = 10, threshold = 0.7 } = options;
    
    // Use Supabase RPC function for vector search
    const { data, error } = await this.supabase
      .rpc('match_meeting_chunks', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit
      });

    if (error) {
      this.logger.error('Vector search failed', { error });
      throw new Error(`Vector search failed: ${error.message}`);
    }

    return data || [];
  }
}

// Export function to replace DatabaseService
export function createSupabaseDatabase(env: any, logger: any) {
  return new SupabaseDatabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, logger);
}