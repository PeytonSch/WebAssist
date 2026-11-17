import { describe, expect, it } from 'vitest';
import { isIdSegment, RouteMatcher, serverPath, splitUrl } from '../src/shared/route';

describe('isIdSegment', () => {
  it('recognises identifiers by shape', () => {
    for (const id of [
      '12345', '42', '-7', '3.14',
      '550e8400-e29b-41d4-a716-446655440000', '550e8400e29b41d4a716446655440000',
      '507f1f77bcf86cd799439011', // Mongo ObjectId
      '2026-11-16', '2026-11-16T10:00:00Z',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV', // ULID
      'dGhpcyBpcyBhIHRva2VuMTIz', // base64
      'jane.doe%40example.com',
    ]) expect(isIdSegment(id), id).toBe(true);
  });

  it('leaves resource names alone', () => {
    for (const word of ['user', 'id', 'api', 'v1', 'v2', 'orders', 'customer-details', 'deadbeefcafe', 'x1', 'report.pdf', 'getUserProfileSettings', ''])
      expect(isIdSegment(word), word).toBe(false);
  });
});

describe('splitUrl', () => {
  it('drops the origin and fragment and keeps the query', () => {
    expect(splitUrl('http://localhost:8080/user/id/12?x=1#top')).toEqual({ path: '/user/id/12', query: '?x=1' });
    expect(splitUrl('/a/b')).toEqual({ path: '/a/b', query: '' });
    expect(splitUrl('https://host')).toEqual({ path: '/', query: '' });
    expect(splitUrl('/a?')).toEqual({ path: '/a', query: '' });
  });
});

describe('RouteMatcher without a spec', () => {
  const m = new RouteMatcher();

  it('names a path by its non-ID segments', () => {
    expect(m.route('/user/id/12345')).toMatchObject({ label: 'user/id', template: '/user/id/{id}', params: ['12345'], query: '' });
    expect(m.route('http://localhost:4010/api/orders?page=2')).toMatchObject({ label: 'api/orders', params: [], query: '?page=2' });
  });

  it('keeps IDs in the middle as placeholders', () => {
    expect(m.route('/orders/42/items/7')).toMatchObject({ label: 'orders/{id}/items', template: '/orders/{id}/items/{id}', params: ['42', '7'] });
  });

  it('gives the same label to the same endpoint with different IDs', () => {
    const a = m.route('/files/507f1f77bcf86cd799439011/versions');
    const b = m.route('/files/507f191e810c19729de860ea/versions');
    expect(a.label).toBe(b.label);
  });

  it('handles the root and all-ID paths', () => {
    expect(m.route('/').label).toBe('/');
    expect(m.route('/12345')).toMatchObject({ label: '{id}', params: ['12345'] });
  });
});

describe('RouteMatcher with spec templates', () => {
  const m = new RouteMatcher([
    { path: '/api/users/{username}', method: 'GET', title: 'Get a user · Shop' },
    { path: '/api/users/me', method: 'GET', title: 'Current user · Shop' },
    { path: '/api/orders/{id}/items', method: '', title: 'Order items · Shop' },
  ]);

  it('uses the spec, which also catches IDs that look like words', () => {
    expect(m.route('/api/users/john', 'GET')).toMatchObject({ label: 'api/users', params: ['john'], title: 'Get a user · Shop' });
  });

  it('prefers fixed segments over placeholders', () => {
    expect(m.route('/api/users/me', 'GET')).toMatchObject({ label: 'api/users/me', params: [], title: 'Current user · Shop' });
  });

  it('keeps the query and falls back to any method, then to shapes', () => {
    expect(m.route('/api/orders/42/items?page=2', 'POST')).toMatchObject({ label: 'api/orders/{id}/items', query: '?page=2', title: 'Order items · Shop' });
    expect(m.route('/api/users/john', 'DELETE')).toMatchObject({ label: 'api/users', title: 'Get a user · Shop' });
    expect(m.route('/other/99')).toMatchObject({ label: 'other', title: null });
  });
});

describe('serverPath', () => {
  it('is the path part of a server URL', () => {
    expect(serverPath('http://localhost:8080/api/')).toBe('/api');
    expect(serverPath('/v2')).toBe('/v2');
    expect(serverPath('https://host')).toBe('');
    expect(serverPath('{scheme}://host/{basePath}')).toBe('/x');
  });
});
