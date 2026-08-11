CREATE TABLE "diarization_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text NOT NULL,
	"task_id" text,
	"speakers_found" smallint,
	"audio_duration_ms" integer,
	"compute_ms" integer,
	"realtime_factor" real,
	"cost_usd" numeric(12, 6),
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "speaker_turns" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "speaker_turns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"diarization_run_id" uuid NOT NULL,
	"speaker_id" uuid,
	"raw_key" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	CONSTRAINT "speaker_turns_interval" CHECK ("speaker_turns"."start_ms" <= "speaker_turns"."end_ms")
);
--> statement-breakpoint
CREATE TABLE "speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"key" text NOT NULL,
	"display_name" text,
	"color_idx" smallint DEFAULT 0 NOT NULL,
	"is_merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diarization_runs" ADD CONSTRAINT "diarization_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diarization_runs" ADD CONSTRAINT "diarization_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_turns" ADD CONSTRAINT "speaker_turns_diarization_run_id_diarization_runs_id_fk" FOREIGN KEY ("diarization_run_id") REFERENCES "public"."diarization_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_turns" ADD CONSTRAINT "speaker_turns_speaker_id_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."speakers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speaker_turns_run_start" ON "speaker_turns" USING btree ("diarization_run_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "speakers_job_key" ON "speakers" USING btree ("job_id","key");--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_speaker_id_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."speakers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "words" ADD CONSTRAINT "words_speaker_id_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."speakers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segments_needs_speaker_review" ON "segments" USING btree ("run_id","idx") WHERE "segments"."needs_speaker_review";