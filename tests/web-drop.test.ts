import { describe, expect, test } from 'bun:test';
import { pasteText, pathsFromDrop, quoteForShell } from '../web/drop';

describe('pathsFromDrop', () => {
  test('text/uri-list with two files and a comment line', () => {
    const uriList = '# dragged from Files\r\nfile:///home/a/notes.md\r\nfile:///home/a/My%20Docs/x.txt\r\nhttps://example.com/y\r\n';
    expect(pathsFromDrop({ uriList })).toEqual(['/home/a/notes.md', '/home/a/My Docs/x.txt']);
  });

  test('File objects with a path property (some webviews add it)', () => {
    expect(pathsFromDrop({ files: [{ name: 'a.txt', path: '/tmp/a.txt' }, { name: 'b.txt' }] })).toEqual(['/tmp/a.txt']);
  });

  test('a text/plain value that is an absolute path or a file:// URI', () => {
    expect(pathsFromDrop({ text: '/home/a/b c.txt' })).toEqual(['/home/a/b c.txt']);
    expect(pathsFromDrop({ text: 'file:///home/a/b%27c.txt' })).toEqual(["/home/a/b'c.txt"]);
  });

  test('a path with a control character is dropped (ESC could end the bracketed paste)', () => {
    expect(pathsFromDrop({ uriList: 'file:///tmp/a%1B%5B201~b\nfile:///tmp/ok' })).toEqual(['/tmp/ok']);
    expect(pathsFromDrop({ files: [{ name: 'x', path: '/tmp/x\u007f' }] })).toEqual([]);
    expect(pathsFromDrop({ text: 'file:///tmp/a%0D' })).toEqual([]);
  });

  test('nothing usable gives []', () => {
    expect(pathsFromDrop({})).toEqual([]);
    expect(pathsFromDrop({ uriList: '# only a comment\n', text: 'hello world', files: [{ name: 'a.txt' }] })).toEqual([]);
    expect(pathsFromDrop({ text: 'https://example.com/a' })).toEqual([]);
    // A text with a line that is not a path is refused: the newline would run a command.
    expect(pathsFromDrop({ text: '/tmp/a\nrm -rf ~' })).toEqual([]);
  });
});

describe('quoteForShell and pasteText', () => {
  test('a plain path stays as it is', () => {
    expect(quoteForShell('/home/a/notes-1.md')).toBe('/home/a/notes-1.md');
    expect(quoteForShell('~/x@y/%+=:,.txt')).toBe('~/x@y/%+=:,.txt');
  });

  test('spaces and quotes are single-quoted', () => {
    expect(quoteForShell('/home/a/My Docs/x.txt')).toBe("'/home/a/My Docs/x.txt'");
    expect(quoteForShell("/home/a/it's.txt")).toBe("'/home/a/it'\\''s.txt'");
    expect(quoteForShell('/a/$(rm -rf).txt')).toBe("'/a/$(rm -rf).txt'");
  });

  test('pasteText joins the quoted paths with a space and ends with a space', () => {
    expect(pasteText(['/a/b', '/c d/e'])).toBe("/a/b '/c d/e' ");
  });
});
