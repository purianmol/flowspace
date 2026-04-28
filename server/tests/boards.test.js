import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

// Helper: an authenticated supertest agent pre-seeded with a JWT header.
class AuthedClient {
  constructor(token) {
    this.token = token;
  }
  auth(req) {
    return req.set('Authorization', `Bearer ${this.token}`);
  }
}

async function makeUser(name = 'User', email = `${name.toLowerCase()}@test.com`) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name, email, password: 'password123' });
  return new AuthedClient(res.body.token);
}

let owner;
let member;
let outsider;

beforeEach(async () => {
  owner = await makeUser('Owner', 'owner@test.com');
  member = await makeUser('Member', 'member@test.com');
  outsider = await makeUser('Outsider', 'outsider@test.com');
});

describe('boards CRUD', () => {
  it('creates a board and lists it', async () => {
    await owner.auth(request(app).post('/api/boards')).send({ title: 'My Board' }).expect(201);
    const list = await owner.auth(request(app).get('/api/boards'));
    expect(list.body.boards).toHaveLength(1);
    expect(list.body.boards[0].title).toBe('My Board');
  });

  it('only shows boards the caller belongs to', async () => {
    await owner.auth(request(app).post('/api/boards')).send({ title: 'Owners board' });
    const res = await outsider.auth(request(app).get('/api/boards'));
    expect(res.body.boards).toHaveLength(0);
  });

  it('owner can rename a board', async () => {
    const created = await owner.auth(request(app).post('/api/boards')).send({ title: 'Old' });
    const id = created.body.board._id;
    const res = await owner.auth(request(app).patch(`/api/boards/${id}`)).send({ title: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.board.title).toBe('New');
  });

  it('non-member cannot access a board (403)', async () => {
    const created = await owner.auth(request(app).post('/api/boards')).send({ title: 'Private' });
    const id = created.body.board._id;
    const res = await outsider.auth(request(app).get(`/api/boards/${id}`));
    expect(res.status).toBe(403);
  });

  it('owner can delete a board', async () => {
    const created = await owner.auth(request(app).post('/api/boards')).send({ title: 'Tmp' });
    const id = created.body.board._id;
    await owner.auth(request(app).delete(`/api/boards/${id}`)).expect(204);
    await owner.auth(request(app).get(`/api/boards/${id}`)).expect(404);
  });
});

describe('membership', () => {
  let boardId;
  beforeEach(async () => {
    const res = await owner
      .auth(request(app).post('/api/boards'))
      .send({ title: 'Shared board' });
    boardId = res.body.board._id;
  });

  it('owner can add a member by email', async () => {
    const res = await owner
      .auth(request(app).post(`/api/boards/${boardId}/members`))
      .send({ email: 'member@test.com' });
    expect(res.status).toBe(201);
    expect(res.body.board.members).toHaveLength(2);
  });

  it('added member can read the board', async () => {
    await owner
      .auth(request(app).post(`/api/boards/${boardId}/members`))
      .send({ email: 'member@test.com' });
    const res = await member.auth(request(app).get(`/api/boards/${boardId}`));
    expect(res.status).toBe(200);
  });

  it('member cannot rename the board (owner-only, 403)', async () => {
    await owner
      .auth(request(app).post(`/api/boards/${boardId}/members`))
      .send({ email: 'member@test.com' });
    const res = await member
      .auth(request(app).patch(`/api/boards/${boardId}`))
      .send({ title: 'Hacked' });
    expect(res.status).toBe(403);
  });
});
