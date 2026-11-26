import { failBootLoadingStatus, startBootLoadingStatus } from "./loading-status";

startBootLoadingStatus();
const timeout = setTimeout(() => failBootLoadingStatus(), 20_000);
void import("./main").catch(() => failBootLoadingStatus()).finally(() => clearTimeout(timeout));
