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
