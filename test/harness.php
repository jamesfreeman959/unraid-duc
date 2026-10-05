<?php
/* Local test harness: serves the plugin pages outside Unraid (php -S router). */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(DiskUsage|DiskUsageSettings)$#', $uri, $m)) {
    function autov($p) { echo $p; }
    function mk_option($sel, $val, $text) { return "<option value='$val'" . ($val == $sel ? ' selected' : '') . ">$text</option>"; }
    function _($s) { return $s; }
    $page = file_get_contents("/usr/local/emhttp/plugins/duc/{$m[1]}.page");
    $page = substr($page, strpos($page, "\n---\n") + 5);
    $page = preg_replace('/_\((.*?)\)_/', '$1', $page);
    echo "<!doctype html><html><head><meta charset='utf-8'><title>duc harness</title>",
         "<link rel='stylesheet' href='https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css'>",
         "<script src='https://code.jquery.com/jquery-3.7.1.min.js'></script>",
         "<script>var csrf_token='test';</script>",
         "<style>body{font-family:clear-sans,Arial,sans-serif;font-size:13px;margin:20px;background:#1c1b1b;color:#f2f2f2} a{color:#ff8c2f} select,input{background:#262626;color:#f2f2f2;border:1px solid #555;padding:4px}</style>",
         "</head><body>";
    eval('?>' . $page);
    echo "</body></html>";
    return true;
}
return false;   // static files and api.php
