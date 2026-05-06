@echo off
@setlocal EnableDelayedExpansion
@set "startTime=%time: =0%"

echo Computer NAME : %COMPUTERNAME%
set "datestamp=%date:~6,4%%date:~3,2%%date:~0,2%"
echo DATESTAMP from date : %datestamp%
echo ""

timeout 2

REM PostgreSQL
echo "PostgreSQL bkp start"
set "PGPASSWORD=1"
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -d chat -F p -v -f "C:\0\PostgreSQL\chat_PostgreSQL_18_%datestamp%.backup"
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -d WebAppMVC -F p -v -f "C:\0\PostgreSQL\WebAppMVC_PostgreSQL_18_%datestamp%.backup"
"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -U postgres -d polJIRA -F p -v -f "C:\0\PostgreSQL\polJIRA_PostgreSQL_18_%datestamp%.backup"
echo "PostgreSQL bkp end"
REM PostgreSQL