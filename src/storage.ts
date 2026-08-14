import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Almacenamiento del historial (informes JSON + capturas PNG).
 *
 * Dos backends con la MISMA interfaz de claves ("index.json", "<runId>/result.json",
 * "<runId>/0-la-home-carga.png"):
 *
 *  - Disco (por defecto, para local): guarda bajo `runs/`.
 *  - DO Spaces / S3 (para producción): guarda en un bucket. Es DURADERO — sobrevive a los
 *    redeploys de DigitalOcean, cuyo disco es efímero.
 *
 * El backend se elige por entorno: si están las variables SPACES_* se usa Spaces; si no, disco.
 */
export interface Storage {
  putJson(key: string, data: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  putImage(key: string, body: Buffer): Promise<void>;
  getImage(key: string): Promise<Buffer | null>;
  /** Etiqueta legible del backend, para el log de arranque. */
  describe(): string;
}

// ---------------------------------------------------------------------------
// Disco (local / fallback)
// ---------------------------------------------------------------------------
class DiskStorage implements Storage {
  private root = path.resolve('runs');

  private full(key: string): string {
    return path.join(this.root, key);
  }

  async putJson(key: string, data: unknown): Promise<void> {
    const p = this.full(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(data, null, 2));
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.full(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async putImage(key: string, body: Buffer): Promise<void> {
    const p = this.full(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async getImage(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.full(key));
    } catch {
      return null;
    }
  }

  describe(): string {
    return `disco (${this.root})`;
  }
}

// ---------------------------------------------------------------------------
// DO Spaces / S3 (producción, duradero)
// ---------------------------------------------------------------------------
class SpacesStorage implements Storage {
  private prefix = (process.env.SPACES_PREFIX ?? 'runs').replace(/\/+$/, '');

  constructor(
    private client: S3Client,
    private bucket: string,
    private endpoint: string,
  ) {}

  private key(k: string): string {
    return `${this.prefix}/${k}`;
  }

  async putJson(key: string, data: unknown): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      const text = await r.Body?.transformToString();
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  }

  async putImage(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: body,
        ContentType: 'image/png',
      }),
    );
  }

  async getImage(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }

  describe(): string {
    return `DO Spaces (${this.bucket} @ ${this.endpoint}, prefijo ${this.prefix})`;
  }
}

/** Construye el backend según el entorno. Spaces si está configurado; disco en caso contrario. */
export function makeStorage(): Storage {
  const { SPACES_KEY, SPACES_SECRET, SPACES_BUCKET, SPACES_ENDPOINT } = process.env;
  if (SPACES_KEY && SPACES_SECRET && SPACES_BUCKET && SPACES_ENDPOINT) {
    const client = new S3Client({
      // DO Spaces es S3-compatible: endpoint tipo https://nyc3.digitaloceanspaces.com
      endpoint: SPACES_ENDPOINT,
      region: process.env.SPACES_REGION ?? 'us-east-1',
      credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
      forcePathStyle: false,
    });
    return new SpacesStorage(client, SPACES_BUCKET, SPACES_ENDPOINT);
  }
  return new DiskStorage();
}

export const storage: Storage = makeStorage();
