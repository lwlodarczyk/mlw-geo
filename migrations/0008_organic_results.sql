-- Organic top 10 from the google.pl response AI Overviews already fetches
-- (mlw-geo, Day 23c). Feeds the "Google visibility" area of the SEO report:
-- same buyer questions, same run, no extra searches. NULL for other engines
-- and for rows captured before this migration.
--
-- Apply with:
--   npx wrangler d1 migrations apply mlw-geo-db --remote

ALTER TABLE prompt_responses ADD COLUMN organic_json TEXT;
