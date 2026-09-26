import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons=cronJobs();
crons.cron("REST telemetry probe","* * * * *",internal.telemetry.probe,{});
crons.interval("Expire operational metrics",{minutes:5},internal.telemetry.purge,{});
crons.cron("Operator alerts","* * * * *",internal.alerts.check,{});
export default crons;
