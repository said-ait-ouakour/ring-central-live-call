import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferSpeakerRole } from '../src/speaker-role.mjs';

const staff = [
  { name: 'Jack Alexander Rigg', email: 'jack.rigg@tabifa.com' },
  { name: 'Hasan Khan', email: 'hasan.khan@tabifa.com' },
  { name: 'Hossein Nokhasteh', email: 'hossein@tab-legal.com' },
  { name: 'Andrew Oliver', email: 'andrew.oliver@tabifa.com' },
];

test('the client by full name', () => {
  assert.equal(inferSpeakerRole('Ruth Kissin', { clientNames: ['Ruth Kissin'], staff }), 'client');
});

test('the client with a middle name missing (judy yhap)', () => {
  assert.equal(inferSpeakerRole('judy yhap', { clientNames: ['Bernice Judy Yhap'], staff, advisorName: 'Andrew Oliver' }), 'client');
});

test('one of a joint client (William Castle)', () => {
  assert.equal(
    inferSpeakerRole('William Castle', { clientNames: ['William Thomas & Jane Margaret Castle'], staff, advisorName: 'Hasan Khan' }),
    'client',
  );
});

test('titles in the CRM name are ignored', () => {
  assert.equal(inferSpeakerRole('Edward Holtom', { clientNames: ['Mr Edward Holtom'] }), 'client');
});

test('the client shown as an email address', () => {
  assert.equal(inferSpeakerRole('moniquegaze@btinternet.com', { clientNames: ['Monique Gaze'], staff }), 'client');
});

test('a nickname on a client meeting is the client', () => {
  assert.equal(inferSpeakerRole('Liz Smith', { clientNames: ['Elizabeth Smith'], staff, advisorName: 'Hasan Khan' }), 'client');
});

test('the adviser is advisor, not unknown', () => {
  assert.equal(inferSpeakerRole('Jack Alexander Rigg', { clientNames: ['Ruth Kissin'], staff, advisorName: 'Jack Alexander Rigg' }), 'advisor');
  assert.equal(inferSpeakerRole('Jack Rigg', { clientNames: ['Ruth Kissin'], staff }), 'advisor');
  assert.equal(inferSpeakerRole('Jack', { clientNames: ['Ruth Kissin'], staff, advisorName: 'Jack Alexander Rigg' }), 'advisor');
});

test('a colleague sitting in is advisor', () => {
  assert.equal(inferSpeakerRole('Hossein Nokhasteh', { clientNames: ['William Castle'], staff, advisorName: 'Hasan Khan' }), 'advisor');
});

test('a staff email is advisor', () => {
  assert.equal(inferSpeakerRole('someone@tab-legal.com', { clientNames: ['Monique Gaze'], staff }), 'advisor');
  assert.equal(inferSpeakerRole('hasan.khan@tabifa.com', { clientNames: ['Monique Gaze'], staff }), 'advisor');
});

test('placeholders stay unknown', () => {
  for (const name of ['Unknown Speaker', 'Speaker 2', 'unassigned', '', null]) {
    assert.equal(inferSpeakerRole(name, { clientNames: ['Ruth Kissin'], staff }), 'unknown');
  }
});

test('no client on the meeting: only staff are tagged', () => {
  assert.equal(inferSpeakerRole('Someone Else', { clientNames: [], staff }), 'unknown');
  assert.equal(inferSpeakerRole('Hasan Khan', { clientNames: [], staff }), 'advisor');
});

test('staff list not read: no guessing, only a name match tags the client', () => {
  assert.equal(inferSpeakerRole('Ruth Kissin', { clientNames: ['Ruth Kissin'], staff: null }), 'client');
  assert.equal(inferSpeakerRole('Jack Rigg', { clientNames: ['Ruth Kissin'], staff: null }), 'unknown');
});

test('a single first name that is not the adviser is the client on a client meeting', () => {
  assert.equal(inferSpeakerRole('Monique', { clientNames: ['Monique Gaze'], staff, advisorName: 'Jack Alexander Rigg' }), 'client');
});
