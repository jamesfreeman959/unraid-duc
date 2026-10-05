<?php
/*
 * JSON API used by the Disk Usage pages.
 *
 *   GET  ?action=status                       indexer state + database info
 *   GET  ?action=ls&path=/mnt/user&levels=3   directory tree from the index
 *   POST action=index                         start an index run
 *   POST action=cancel                        cancel a running index
 *
 * POST requests are CSRF-checked by the webGUI (local_prepend.php).
 */

require_once __DIR__ . '/common.php';

function reply(int $code, array $body): void
{
    http_response_code($code);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($body);
    exit;
}

/* Parse `duc info -b` output: "YYYY-MM-DD HH:MM:SS  files  dirs  bytes  path". */
function index_roots(string $db): array
{
    [$rc, $out] = duc_run([DUC_BIN, 'info', '-b', '-d', $db]);
    if ($rc !== 0) return [];
    $roots = [];
    foreach (explode("\n", $out) as $line) {
        if (preg_match('/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\d+)\s+(\d+)\s+(\d+) (.+)$/', $line, $m)) {
            $roots[] = ['path' => $m[5], 'indexed' => strtotime($m[1]),
                        'files' => (int)$m[2], 'dirs' => (int)$m[3], 'size' => (int)$m[4]];
        }
    }
    return $roots;
}

$cfg = duc_config();
$db = $cfg['DB_PATH'] ?? '';
$action = $_POST['action'] ?? $_GET['action'] ?? '';

switch ($action) {

case 'status':
    $status = duc_status();
    $exists = $db !== '' && is_file($db);
    reply(200, [
        'status'   => $status,
        'database' => ['path' => $db, 'exists' => $exists,
                       'size' => $exists ? filesize($db) : 0,
                       'modified' => $exists ? filemtime($db) : 0],
        'roots'    => $exists ? index_roots($db) : [],
        'log'      => ($status['state'] ?? '') === 'failed'
                      ? array_slice(file(DUC_LOG, FILE_IGNORE_NEW_LINES) ?: [], -20) : [],
    ]);

case 'ls':
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') reply(405, ['error' => 'GET required']);
    if (!is_file($db)) reply(404, ['error' => 'No index yet. Run the indexer first.']);
    $path = (string)($_GET['path'] ?? '');
    if ($path === '' || $path[0] !== '/') reply(400, ['error' => 'Invalid path']);
    $levels = max(1, min(6, (int)($_GET['levels'] ?? 1)));
    $min = max(0, (int)($_GET['min'] ?? 0));
    $argv = [DUC_BIN, 'json', '-d', $db, '--levels', (string)$levels, '--min_size', (string)$min];
    if (($_GET['apparent'] ?? '') === '1') $argv[] = '--apparent';
    $argv[] = $path;
    [$rc, $out, $err] = duc_run($argv);
    if ($rc !== 0) reply(404, ['error' => strtok(trim($err), "\n") ?: 'Unable to read index']);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo $out;
    exit;

case 'index':
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['error' => 'POST required']);
    if ((duc_status()['state'] ?? '') === 'running') reply(409, ['error' => 'Index already running']);
    exec('nohup ' . escapeshellarg(DUC_DOCROOT . '/scripts/duc-index') . ' manual > /dev/null 2>&1 &');
    usleep(300000);
    reply(202, ['started' => true]);

case 'cancel':
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['error' => 'POST required']);
    duc_run([DUC_DOCROOT . '/scripts/duc-index', '--cancel']);
    reply(200, ['cancelled' => true]);

default:
    reply(400, ['error' => 'Unknown action']);
}
