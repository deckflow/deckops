/**
 * Files at or above this size are uploaded to storage first (chunked, via
 * presigned URLs) and the task references the fileId. Inlining a large
 * multipart body into task creation trips gateway timeouts, and retrying
 * that POST is not idempotent — the real backend showed one 9 MB pptx
 * spawning eight duplicate tasks. Small synthetic files never hit it.
 */
export const PRE_UPLOAD_THRESHOLD = 4 * 1024 * 1024;
