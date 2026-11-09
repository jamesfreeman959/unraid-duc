<?php
/* Shared helpers for the duc plugin (used by the webGUI and the CLI scripts). */

const DUC_PLUGIN   = 'duc';
const DUC_BIN      = '/usr/local/bin/duc';
const DUC_DOCROOT  = '/usr/local/emhttp/plugins/duc';
const DUC_CFG_FILE = '/boot/config/plugins/duc/duc.cfg';
const DUC_RUN_DIR  = '/var/run/duc';
const DUC_STATUS   = DUC_RUN_DIR . '/status.json';
const DUC_LOCK     = DUC_RUN_DIR . '/index.lock';
const DUC_LOG      = '/var/log/duc-index.log';

function duc_config(): array
{
    $cfg = @parse_ini_file(DUC_DOCROOT . '/default.cfg') ?: [];
    if (is_file(DUC_CFG_FILE)) {
        $cfg = array_merge($cfg, @parse_ini_file(DUC_CFG_FILE) ?: []);
    }
    return $cfg;
}

/* Index roots are stored one per line (newlines or commas accepted). */
function duc_index_paths(array $cfg): array
{
    $paths = preg_split('/[\r\n,]+/', $cfg['INDEX_PATHS'] ?? '');
    $paths = array_map(fn($p) => rtrim(trim($p), '/') ?: '/', $paths);
    return array_values(array_unique(array_filter($paths, fn($p) => $p !== '' && $p[0] === '/')));
}

function duc_exclude_patterns(array $cfg): array
{
    $patterns = preg_split('/[\r\n,]+/', $cfg['EXCLUDE'] ?? '');
    return array_values(array_filter(array_map('trim', $patterns), 'strlen'));
}

function duc_status(): array
{
    $status = @json_decode(@file_get_contents(DUC_STATUS), true) ?: ['state' => 'idle'];
    if (($status['state'] ?? '') === 'running') {
        $pid = (int)($status['pid'] ?? 0);
        if ($pid <= 0 || !file_exists("/proc/$pid")) {
            $status['state'] = 'failed';
            $status['message'] = 'Indexer stopped unexpectedly';
        }
    }
    return $status;
}

function duc_write_status(array $status): void
{
    @mkdir(DUC_RUN_DIR, 0755, true);
    $tmp = DUC_STATUS . '.tmp';
    file_put_contents($tmp, json_encode($status));
    rename($tmp, DUC_STATUS);
}

/* Run a command (argv array, no shell) and return [exit code, stdout, stderr]. */
function duc_run(array $argv): array
{
    $proc = proc_open($argv, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) return [127, '', 'failed to start ' . $argv[0]];
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($proc), $out, $err];
}

/* ---------- size history ---------- */

// Folders below the first level are only recorded from this size, to keep the history small.
const DUC_HISTORY_MIN_SIZE = 1073741824;
const DUC_JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

function duc_history_enabled(array $cfg): bool
{
    return ($cfg['HISTORY'] ?? 'yes') === 'yes';
}

/* The history lives next to the index: duc.db -> duc.history.jsonl */
function duc_history_file(array $cfg): string
{
    $db = $cfg['DB_PATH'] ?? '';
    return $db === '' ? '' : preg_replace('/\.db$/', '', $db) . '.history.jsonl';
}

function duc_history_depth(array $cfg): int
{
    return max(1, min(3, (int)($cfg['HISTORY_DEPTH'] ?? 2)));
}

/* Path of $path relative to $root ('' for the root itself), or null if it is outside. */
function duc_relative(string $root, string $path): ?string
{
    if ($path === $root) return '';
    $prefix = $root === '/' ? '/' : "$root/";
    return strncmp($path, $prefix, strlen($prefix)) === 0 ? substr($path, strlen($prefix)) : null;
}

/*
 * Append one line per root to the history file:
 *   {"time":..., "root":"/mnt/user", "entries":{"": [actual, apparent, count], "appdata": [...], ...}}
 * The sizes come from the index that was just built, so nothing is scanned again.
 * Returns the number of folders recorded.
 */
function duc_record_history(array $cfg, string $db, array $roots, int $time): int
{
    $file = duc_history_file($cfg);
    if ($file === '') throw new RuntimeException('No database path configured');
    $depth = duc_history_depth($cfg);
    $passes = [[1, 0]];
    if ($depth > 1) $passes[] = [$depth, DUC_HISTORY_MIN_SIZE];

    $lines = '';
    $recorded = 0;
    foreach ($roots as $root) {
        $entries = [];
        foreach ($passes as [$levels, $min]) {
            [$rc, $out, $err] = duc_run([DUC_BIN, 'json', '-d', $db, '--levels', (string)$levels,
                                         '--min_size', (string)$min, $root]);
            $tree = $rc === 0 ? json_decode($out, true, 512, JSON_INVALID_UTF8_SUBSTITUTE) : null;
            if (!is_array($tree)) {
                throw new RuntimeException("Unable to read $root from the index: " . (strtok(trim($err), "\n") ?: 'invalid JSON'));
            }
            $entries[''] = [(int)$tree['size_actual'], (int)$tree['size_apparent'], (int)$tree['count']];
            $walk = function (array $node, string $rel, int $level) use (&$walk, &$entries, $levels) {
                foreach ($node['children'] ?? [] as $child) {
                    if (($child['type'] ?? '') !== 'dir') continue;
                    $key = $rel === '' ? (string)$child['name'] : "$rel/{$child['name']}";
                    $entries[$key] = [(int)$child['size_actual'], (int)$child['size_apparent'], (int)$child['count']];
                    if ($level < $levels) $walk($child, $key, $level + 1);
                }
            };
            $walk($tree, '', 1);
        }
        $recorded += count($entries) - 1;
        $lines .= json_encode(['time' => $time, 'root' => $root, 'entries' => (object)$entries], DUC_JSON_FLAGS) . "\n";
    }

    duc_prune_history($file, (int)($cfg['HISTORY_DAYS'] ?? 0), $time);
    if (@file_put_contents($file, $lines, FILE_APPEND | LOCK_EX) === false) {
        throw new RuntimeException("Unable to write $file");
    }
    return $recorded;
}

/* Drop snapshots older than $days (0 keeps everything). */
function duc_prune_history(string $file, int $days, int $now): void
{
    if ($days <= 0 || !is_file($file)) return;
    $cutoff = $now - $days * 86400;
    $keep = [];
    $dropped = false;
    foreach (file($file) ?: [] as $line) {
        $s = json_decode($line, true);
        if (is_array($s) && (int)($s['time'] ?? 0) < $cutoff) { $dropped = true; continue; }
        $keep[] = $line;
    }
    if (!$dropped) return;
    if (@file_put_contents("$file.tmp", implode('', $keep)) !== false) @rename("$file.tmp", $file);
}

/*
 * History of one folder and its subfolders:
 *   points   [[time, actual, apparent, count], ...] for $path itself
 *   children {name: [[time, actual, apparent, count], ...]} for the folders directly below it
 */
function duc_read_history(array $cfg, string $root, string $rel): array
{
    $points = [];
    $children = [];
    $since = null;
    $fh = @fopen(duc_history_file($cfg), 'r');
    if ($fh) {
        $prefix = $rel === '' ? '' : "$rel/";
        while (($line = fgets($fh)) !== false) {
            $s = json_decode($line, true, 512, JSON_INVALID_UTF8_SUBSTITUTE);
            if (!is_array($s) || ($s['root'] ?? null) !== $root || !is_array($s['entries'] ?? null)) continue;
            $t = (int)$s['time'];
            $since = $since ?? $t;
            foreach ($s['entries'] as $key => $v) {
                $key = (string)$key;
                if ($key === $rel) {
                    $points[] = array_merge([$t], $v);
                } elseif ($prefix === '' || strncmp($key, $prefix, strlen($prefix)) === 0) {
                    $name = substr($key, strlen($prefix));
                    if ($name !== '' && strpos($name, '/') === false) $children[$name][] = array_merge([$t], $v);
                }
            }
        }
        fclose($fh);
    }
    return ['since' => $since, 'points' => $points, 'children' => (object)$children];
}
