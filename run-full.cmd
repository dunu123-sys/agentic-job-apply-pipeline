@echo off
rem Job-apply pipeline full run: discover (jobs and/or posts) -> enrich -> score.
rem Launched detached (Win32_Process.Create) by the Gosplan /api/jobapply route
rem so it survives Next dev-server hot reloads. Owns its own log redirect.
rem Usage: run-full.cmd [jobs|posts|both] [description]
rem   arg1 scrape source (default: both, operator rule 2026-10-25)
rem   arg2 target-role description name (default: settings.active_description)
set SCRAPE=%1
if "%SCRAPE%"=="" set SCRAPE=both
set DESC=%2
cd /d .
if "%DESC%"=="" (
  node pipeline.mjs all --scrape=%SCRAPE% < NUL > run-log.txt 2>&1
) else (
  node pipeline.mjs all --scrape=%SCRAPE% --desc=%DESC% < NUL > run-log.txt 2>&1
)
