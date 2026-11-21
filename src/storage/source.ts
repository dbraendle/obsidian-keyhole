/**
 * Bytes that can be read range by range, so a large upload never has to be in
 * memory as a whole: a file as it is, or a file that is encrypted while it is read.
 */
export interface ByteSource {
	size: number;
	read(start: number, end: number): Promise<ArrayBuffer>;
}

export function blobSource(blob: Blob): ByteSource {
	return { size: blob.size, read: (start, end) => blob.slice(start, end).arrayBuffer() };
}
