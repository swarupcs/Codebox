import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';

const headers = {
  'Content-Type': 'application/json',
  'X-Auth-Token': AUTH_TOKEN,
};

describe('CodeBox API', () => {
  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.status, 'healthy');
    });
  });

  describe('Languages', () => {
    it('should list active languages', async () => {
      const res = await fetch(`${BASE_URL}/languages`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(Array.isArray(data));
      assert(data.length > 0);
      assert(data.some(l => l.id === 71)); // Python
    });

    it('should get language by ID', async () => {
      const res = await fetch(`${BASE_URL}/languages/71`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.id, 71);
      assert(data.name.includes('Python'));
    });

    it('should return 404 for unknown language', async () => {
      const res = await fetch(`${BASE_URL}/languages/999`, { headers });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('Statuses', () => {
    it('should list all statuses', async () => {
      const res = await fetch(`${BASE_URL}/statuses`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(Array.isArray(data));
      assert(data.some(s => s.id === 3 && s.description === 'Accepted'));
    });
  });

  describe('Submissions', () => {
    let submissionToken;

    it('should create a Python submission', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print("Hello, World!")',
          language_id: 71,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(data.token);
      submissionToken = data.token;
    });

    it('should get submission by token', async () => {
      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      const res = await fetch(`${BASE_URL}/submissions/${submissionToken}`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.token, submissionToken);
      assert(data.status);
    });

    it('should create submission with wait=true', async () => {
      const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print(1 + 1)',
          language_id: 71,
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(data.token);
      assert(data.status);
      // If execution completed, should have stdout
      if (data.status.id === 3) {
        assert(data.stdout.includes('2'));
      }
    });

    it('should validate required fields', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: 71,
          // Missing source_code
        }),
      });

      assert.strictEqual(res.status, 422);
    });

    it('should validate language_id', async () => {
      const res = await fetch(`${BASE_URL}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: 'print("test")',
          language_id: 9999,
        }),
      });

      assert.strictEqual(res.status, 422);
    });
  });

  describe('Batch Submissions', () => {
    it('should create batch submissions', async () => {
      const res = await fetch(`${BASE_URL}/submissions/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          submissions: [
            { source_code: 'print(1)', language_id: 71 },
            { source_code: 'print(2)', language_id: 71 },
          ],
        }),
      });
      const data = await res.json();

      assert.strictEqual(res.status, 201);
      assert(Array.isArray(data));
      assert.strictEqual(data.length, 2);
      assert(data[0].token);
      assert(data[1].token);
    });
  });

  describe('System Info', () => {
    it('should return about info', async () => {
      const res = await fetch(`${BASE_URL}/about`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.version);
    });

    it('should return config info', async () => {
      const res = await fetch(`${BASE_URL}/config_info`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.max_cpu_time_limit);
      assert(data.max_memory_limit);
    });

    it('should return system info', async () => {
      const res = await fetch(`${BASE_URL}/system_info`, { headers });
      const data = await res.json();

      assert.strictEqual(res.status, 200);
      assert(data.system);
      assert(data.cpu);
      assert(data.memory);
    });
  });
});
