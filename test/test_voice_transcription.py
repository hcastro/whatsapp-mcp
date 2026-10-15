import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / ".agents/skills/whatsapp/scripts/transcribe.py"
spec = importlib.util.spec_from_file_location("transcribe_voice", SCRIPT)
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.folder = self.data_dir / "voice-notes/export-test"
        self.folder.parent.mkdir(mode=0o700)
        self.folder.mkdir(mode=0o700)
        self.audio = self.folder / "sample.audio"
        self.audio.write_bytes(b"OggSfixture")
        self.note = {"messageId": "a" * 64, "chatId": "111@lid", "senderId": None,
                     "sentAt": "2026-01-01T12:00:00Z", "path": self.audio.name,
                     "sha256": hashlib.sha256(self.audio.read_bytes()).hexdigest()}
        self.manifest = self.folder / "manifest.json"

    def write(self, notes):
        self.manifest.write_text(json.dumps(notes))

    def test_original_identity_and_bytes(self):
        self.write([self.note])
        notes = voice.read_manifest(self.manifest)
        self.assertEqual(notes[0], (self.note, self.audio.resolve()))

    def test_corruption_and_duplicate_message_ids_fail(self):
        self.write([self.note, self.note])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            voice.read_manifest(self.manifest)
        self.write([self.note])
        self.audio.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum"):
            voice.read_manifest(self.manifest)

    def test_path_escape_and_absolute_paths_fail(self):
        self.write([{**self.note, "path": str(self.audio)}])
        with self.assertRaisesRegex(ValueError, "relative"):
            voice.read_manifest(self.manifest)
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "outside.audio"
            target.write_bytes(b"OggSfixture")
            (self.folder / "link.audio").symlink_to(target)
            self.write([{**self.note, "path": "link.audio"}])
            with self.assertRaisesRegex(ValueError, "within"):
                voice.read_manifest(self.manifest)

    def test_missing_model_does_not_import_runtime_or_write_output(self):
        self.write([self.note])
        with self.assertRaises(FileNotFoundError):
            voice.transcribe_manifest(self.manifest, self.folder / "missing", "en", data_dir=self.data_dir)
        self.assertEqual(list(self.folder.glob("transcript-*")), [])

    def test_playlist_is_rejected_before_decoder(self):
        with patch.object(voice.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                voice.decode_audio(b"#EXTM3U\nhttps://example.com/a.mp3", "ffmpeg")
            run.assert_not_called()

    def test_shared_or_unapproved_output_directory_is_rejected(self):
        self.write([self.note])
        voice.validate_working_directory(self.manifest, self.data_dir)
        self.folder.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "0700"):
            voice.validate_working_directory(self.manifest, self.data_dir)
        self.folder.chmod(0o700)
        with self.assertRaisesRegex(ValueError, "approved"):
            voice.validate_working_directory(self.manifest, self.folder)

    def test_quality_flags_do_not_claim_confidence(self):
        flags = voice.quality_flags({"text": "", "segments": [{"start": 1, "end": 3, "avg_logprob": -2, "compression_ratio": 4}]})
        self.assertEqual(flags[0]["reason"], "no_recognized_speech")
        self.assertEqual(flags[1]["reasons"], ["low_decoder_score", "possible_repetition"])

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for container regression")
    def test_m4a_with_trailing_metadata_decodes(self):
        path = self.folder / "trailing.m4a"
        subprocess.run([shutil.which("ffmpeg"), "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "sine=frequency=440:duration=5", "-c:a", "aac", str(path)], check=True)
        samples = voice.decode_audio(path.read_bytes(), shutil.which("ffmpeg"))
        self.assertGreater(len(samples), 4 * voice.SAMPLE_RATE)
        self.assertLess(len(samples), 6 * voice.SAMPLE_RATE)

    def test_decoding_failure_and_duration_limit_do_not_become_partial_transcripts(self):
        with patch.object(voice.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=b"", stderr=b"error")):
            with self.assertRaisesRegex(ValueError, "decoding failed"):
                voice.decode_audio(b"OggSfixture", "ffmpeg")
        with patch.object(voice, "MAX_SECONDS", 1), patch.object(voice.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"x" * 32002, stderr=b"")):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                voice.decode_audio(b"OggSfixture", "ffmpeg")

    def model_fixture(self):
        model = self.data_dir / "model"
        model.mkdir()
        (model / "config.json").write_text("{}")
        (model / "weights.npz").write_bytes(b"test-only")
        return model

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for damaged-container regression")
    def test_damaged_wav_cannot_produce_completed_transcript(self):
        path = self.folder / "damaged.wav"
        subprocess.run([shutil.which("ffmpeg"), "-nostdin", "-v", "error", "-f", "lavfi",
                        "-i", "sine=frequency=440:duration=5", str(path)], check=True)
        encoded = path.read_bytes()
        path.write_bytes(encoded[:len(encoded) // 2])
        self.write([{**self.note, "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}])
        model = self.model_fixture()
        with patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace()}), patch.object(voice, "version", return_value="test"), patch.dict(os.environ):
            with self.assertRaisesRegex(ValueError, "decoding failed"):
                voice.transcribe_manifest(self.manifest, model, "en", data_dir=self.data_dir)
        self.assertEqual(list(self.folder.glob("transcript-*")), [])

    def test_offline_provenance_unique_private_outputs_and_collision_preservation(self):
        self.write([self.note])
        model = self.model_fixture()
        calls = []
        def recognize(audio, **settings):
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            calls.append(settings)
            return {"text": "Hello, buenos días.", "segments": [], "language": "en"}
        runtime = SimpleNamespace(transcribe=recognize)
        with patch.dict(sys.modules, {"mlx_whisper": runtime}), patch.object(voice, "version", return_value="test"), patch.object(voice, "decode_audio", return_value=[0] * 16000), patch.object(voice.shutil, "which", return_value="ffmpeg"), patch.dict(os.environ):
            first = voice.transcribe_manifest(self.manifest, model, "mixed", data_dir=self.data_dir)
            second = voice.transcribe_manifest(self.manifest, model, "es", True, data_dir=self.data_dir)
            original = first.read_bytes()
            with patch.object(voice.uuid, "uuid4", return_value=SimpleNamespace(hex=first.stem.removeprefix("transcript-"))):
                with self.assertRaises(FileExistsError):
                    voice.transcribe_manifest(self.manifest, model, "en", data_dir=self.data_dir)
            self.assertEqual(first.read_bytes(), original)
        self.assertNotEqual(first, second)
        self.assertEqual(first.stat().st_mode & 0o777, 0o600)
        report = json.loads(original)
        self.assertEqual(report["notes"][0]["source"], self.note)
        self.assertIsNone(calls[0]["language"])
        self.assertEqual(calls[0]["task"], "transcribe")
        self.assertTrue(calls[1]["condition_on_previous_text"])

    def test_later_recognition_failure_leaves_no_completed_transcript(self):
        self.write([self.note, {**self.note, "messageId": "b" * 64}])
        model = self.model_fixture()
        calls = []
        def recognize(audio, **settings):
            calls.append(settings)
            if len(calls) == 1:
                return {"text": "First note.", "segments": [], "language": "en"}
            raise RuntimeError("synthetic recognition failure")
        with patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace(transcribe=recognize)}), patch.object(voice, "version", return_value="test"), patch.object(voice, "decode_audio", return_value=[0]), patch.object(voice.shutil, "which", return_value="ffmpeg"), patch.dict(os.environ):
            with self.assertRaisesRegex(RuntimeError, "synthetic"):
                voice.transcribe_manifest(self.manifest, model, "en", data_dir=self.data_dir)
        self.assertEqual(list(self.folder.glob("transcript-*")), [])


if __name__ == "__main__":
    unittest.main()
