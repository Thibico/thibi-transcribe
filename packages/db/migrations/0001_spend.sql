CREATE TABLE "rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"unit" text NOT NULL,
	"usd_per_unit" double precision NOT NULL,
	"source" text DEFAULT 'default' NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rates_non_negative" CHECK ("rates"."usd_per_unit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" double precision NOT NULL,
	"usd_per_unit" double precision NOT NULL,
	"usd" double precision NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"unit" text NOT NULL,
	"reported" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_non_negative" CHECK ("usage_records"."quantity" >= 0 and "usage_records"."usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rates_key" ON "rates" USING btree ("provider_id","model","unit");--> statement-breakpoint
CREATE INDEX "usage_records_run" ON "usage_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_records_created" ON "usage_records" USING btree ("created_at");