#!/usr/bin/env python3
"""Read-only GUI/IPC smoke of the actual Linux Tauri binary over WebDriver."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.evidence.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {'schemaVersion': 1, 'result': 'FAIL', 'kind': 'actual native Linux GUI and read-only IPC',
              'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'blockchainOperations': False, 'miningStarted': False, 'backendMutations': False}
    def save():
        (output / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    save()
    driver = shutil.which('tauri-driver')
    assert driver and shutil.which('WebKitWebDriver'), 'official native WebDriver binaries required'
    env = os.environ.copy()
    # Isolate user configuration; this runner invokes only status commands.
    for key, leaf in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache')]:
        path = output / leaf
        path.mkdir(mode=0o700)
        env[key] = str(path)
    env['TAURI_WEBVIEW_AUTOMATION'] = 'true'
    base = 'http://127.0.0.1:4444'
    session = None
    def request(method, path, body=None):
        raw = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=raw, headers={'Content-Type': 'application/json'}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=40) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace')
            raise AssertionError(f'WebDriver {method} {path}: {error.code}: {detail}') from error
        value = result.get('value')
        assert not (isinstance(value, dict) and value.get('error')), result
        return value
    def script(value, async_=False):
        return request('POST', f'/session/{session}/execute/{"async" if async_ else "sync"}', {'script': value, 'args': []})
    with (output / 'driver.log').open('wb') as log:
        process = subprocess.Popen([driver, '--port', '4444'], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 60
            while True:
                assert process.poll() is None, 'tauri-driver terminated before session'
                try:
                    request('GET', '/status')
                    break
                except (OSError, AssertionError):
                    assert time.monotonic() < deadline, 'tauri-driver readiness timeout'
                    time.sleep(0.25)
            created = request('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': str(binary)}}}})
            session = created['sessionId']
            request('POST', f'/session/{session}/timeouts', {'script': 30000, 'implicit': 10000, 'pageLoad': 30000})
            deadline = time.monotonic() + 60
            while True:
                state = script('return {url:window.location.href,text:document.body.innerText,bridge:!!window.__TAURI_INTERNALS__,welcome:!!document.querySelector("#start-onboarding")};')
                if report.get('nativeStartup') != state:
                    report['nativeStartup'] = state
                    save()
                if state['bridge'] and state['welcome'] and 'GPUbnb Host' in state['text']:
                    break
                assert time.monotonic() < deadline, f'native UI startup timeout: {state}'
                time.sleep(0.25)
            report['nativeWelcomeRendered'] = True
            status = script('''const done=arguments[arguments.length-1];
              window.__TAURI_INTERNALS__.invoke('host_status').then(
                value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));''', async_=True)
            assert status['ok'], status
            host = status['value']
            assert host['ready'] is False and host['lifecycle'] == 'setup_required', host
            assert host['blockingCount'] > 0 and host['checks'], host
            report['nativeHostStatusFailClosed'] = True
            report['nativeHostStatus'] = host
            refused = script('''const done=arguments[arguments.length-1];
              window.__TAURI_INTERNALS__.invoke('__qualification_unknown_command__').then(
                value=>done({rejected:false}),error=>done({rejected:true,reason:String(error)}));''', async_=True)
            assert refused['rejected'] is True, refused
            assert '__qualification_unknown_command__' in refused.get('reason', '') and 'not found' in refused['reason'].lower(), refused
            report['unknownIpcRejected'] = True
            report['unknownIpcRefusal'] = refused
            button = request('POST', f'/session/{session}/element', {'using': 'css selector', 'value': '#start-onboarding'})
            element = button['element-6066-11e4-a52e-4f735466cecf']
            request('POST', f'/session/{session}/element/{element}/click', {})
            deadline = time.monotonic() + 60
            while True:
                rendered = script('return {layout:!!document.querySelector(".layout"),error:!!document.querySelector(".error-state"),text:document.body.innerText};')
                assert not rendered['error'], rendered
                if rendered['layout']:
                    break
                assert time.monotonic() < deadline, f'read-only status page timeout: {rendered}'
                time.sleep(0.25)
            report['nativeStatusPageRendered'] = True
            (output / 'native-status.txt').write_text(rendered['text'])
            screenshot = base64.b64decode(request('GET', f'/session/{session}/screenshot'), validate=True)
            assert screenshot.startswith(b'\x89PNG\r\n\x1a\n'), 'native screenshot missing'
            (output / 'native-status.png').write_bytes(screenshot)
            report.update(result='PASS', screenshotSha256=hashlib.sha256(screenshot).hexdigest())
            save()
        except Exception as error:
            report['error'] = str(error)
            if session:
                try:
                    report['lastNativePage'] = script('return {url:window.location.href,text:document.body.innerText};')
                    screenshot = base64.b64decode(request('GET', f'/session/{session}/screenshot'), validate=True)
                    assert screenshot.startswith(b'\x89PNG\r\n\x1a\n')
                    (output / 'native-failure.png').write_bytes(screenshot)
                    report['failureScreenshotSha256'] = hashlib.sha256(screenshot).hexdigest()
                except (OSError, AssertionError, ValueError) as diagnostic_error:
                    report['diagnosticError'] = str(diagnostic_error)
            save()
            raise
        finally:
            if session:
                try:
                    request('DELETE', f'/session/{session}')
                except (OSError, AssertionError):
                    pass
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
