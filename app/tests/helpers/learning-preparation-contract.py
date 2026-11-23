"""Synthetic installed-code test; never opens HUD/audio or touches real live state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

app = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='jq-preparation-contract-') as folder:
    root = Path(folder)
    os.environ['INTERVIEW_HOME'] = str(root)
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    sys.dont_write_bytecode = True
    topics = root / 'cheatsheets' / 'topics'
    topics.mkdir(parents=True)
    content = '# Delivery framework\n- Requirements\n- Core entities\n- API / interface\n- High-level design\n'
    (topics / 'delivery-framework.md').write_text(content)
    (topics / 'unselected.md').write_text('# Other\n- UNSELECTED CONTENT\n')

    def load(name):
        spec = importlib.util.spec_from_file_location('jq_contract_' + name, app / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    preparation, capture = load('preparation'), load('capture')
    # Fail before any write if a future installed version stops honoring the
    # fixture root. This contract check must never reach real interview state.
    assert Path(capture.ROOT).resolve() == root.resolve()
    assert Path(preparation.ROOT).resolve() == root.resolve()
    assert Path(capture.SESSION).resolve().is_relative_to(root.resolve())
    source_id = 'concept:resources/cheatsheets/delivery-framework.md'
    empty = preparation.select('system', include=[])
    preparation.attach_selection(empty, preparation.catalog('system'))
    capture.ensure_dirs()
    session = capture.default_session('system', preparation=empty, preparation_cards=[])
    session['question'] = {'id': 1, 'title': 'Design a URL shortener', 'ts': 'synthetic'}
    session['stages'] = {'requirements': {'title': 'Preserve agreed requirements'}}
    capture.save_session(session)
    initial_source = capture.coaching_source(session, 0)
    capture.publish_now({'say': 'Clarify the functional requirements.', 'coming_next': 'Choose a design direction.', 'source': initial_source})

    controller = capture.Capture(dict(capture.DEFAULT_CONFIG))
    # apply_preparation performs only the same local state update as the picker;
    # no Capture.run(), audio worker, server, process or native HUD is started.
    controller.apply_preparation(0, [source_id])
    after = capture.load_session()
    selected = after['preparation']['selected']
    assert [s['id'] for s in selected] == [source_id]
    assert selected[0]['sha256'] == hashlib.sha256(content.encode()).hexdigest()
    assert selected[0]['resolvedPath'] == str((topics / 'delivery-framework.md').resolve())
    assert after['question'] == session['question']
    assert after['stages'] == session['stages']
    assert 'UNSELECTED CONTENT' not in json.dumps(after)
    assert after['preparationRevision'] == 1
    assert [e['revision'] for e in after['preparationHistory']] == [0, 1]
    event = capture.read_jsonl(capture.TRANSCRIPT)[-1]
    assert capture.event_line(event) == 'PREPARATION: revision 1; selected ' + source_id
    # Selection is not an AI generation step. Existing now retains its older
    # watermark until a caller reads the new selection and supplies coaching.
    assert after['now']['source']['preparation_revision'] == 0
    assert after['now']['coming_next'] == 'Choose a design direction.'
    observed = capture.coaching_source(after, len(capture.read_jsonl(capture.TRANSCRIPT)))
    transition = 'Next, name User, ShortLink and RedirectEvent before defining the API.'
    capture.publish_now({'say': 'The requirements are clear; identify the core entities.', 'coming_next': transition, 'source': observed})
    published = capture.load_session()['now']
    assert published['coming_next'] == transition
    assert published['source']['preparation_revision'] == 1
    before_stale = Path(capture.SESSION).read_bytes()
    try:
        controller.apply_preparation(0, [])
        raise AssertionError('stale selection should fail')
    except ValueError:
        assert Path(capture.SESSION).read_bytes() == before_stale
    print(json.dumps({'selectedSnapshotVerified': True, 'reselectionPreservesWork': True,
                      'preparationEventVerified': True, 'comingNextPublicationVerified': True,
                      'automaticCoachingGenerationVerified': False,
                      'example': transition, 'scope': 'synthetic installed-code test; no live session or audio'}))
