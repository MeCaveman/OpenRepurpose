#!/usr/bin/env python3
"""Run one bounded, resumable OpenRepurpose roadmap packet at a time."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import tomllib
from dataclasses import dataclass
from pathlib import Path

PACKET_RE = re.compile(r"^### Packet (?P<number>\d+)\s+—\s+(?P<title>.+?)\s*$", re.MULTILINE)
STOP_MARKER = "ROADMAP_STOP:"


@dataclass(frozen=True)
class Packet:
    version: str
    number: int
    title: str
    body: str


@dataclass(frozen=True)
class Agent:
    role: str
    model: str
    reasoning: str


def fail(message: str) -> None:
    print(f"STOP: {message}", file=sys.stderr)
    raise SystemExit(2)


def run(command: list[str], cwd: Path, check: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        detail = (result.stdout + result.stderr).strip()
        fail(f"Command failed: {' '.join(command)}\n{detail}")
    return result


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_manifest(root: Path) -> dict:
    with (root / "scripts" / "roadmap.json").open(encoding="utf-8") as file:
        return json.load(file)


def parse_packets(root: Path, version: str) -> list[Packet]:
    path = root / "docs" / "roadmap" / f"{version}.md"
    if not path.is_file():
        fail(f"Roadmap file is missing: {path.relative_to(root)}")
    document = path.read_text(encoding="utf-8")
    matches = list(PACKET_RE.finditer(document))
    if not matches:
        fail(f"No packet headings found in {path.relative_to(root)}")
    packets: list[Packet] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(document)
        packets.append(Packet(version, int(match["number"]), match["title"].strip(), document[match.start():end].strip()))
    expected = list(range(1, len(packets) + 1))
    if [packet.number for packet in packets] != expected:
        fail(f"Packet numbering must be contiguous in {path.relative_to(root)}")
    return packets


def completed_packets(root: Path, version: str) -> set[int]:
    path = root / "docs" / "progress" / f"{version}.md"
    if not path.is_file():
        fail(f"Progress file is missing: {path.relative_to(root)}")
    document = path.read_text(encoding="utf-8")
    completed = re.search(r"^## Completed\s*$(.*?)(?=^## |\Z)", document, re.MULTILINE | re.DOTALL)
    if not completed:
        fail(f"Progress file has no Completed section: {path.relative_to(root)}")
    return {int(value) for value in re.findall(r"(?im)^\s*-\s+(?:v[\d.]+\s+)?Packet\s+(\d+)\s*(?:—|-)", completed.group(1))}


def next_packet(root: Path, manifest: dict, version: str | None, number: int | None) -> Packet:
    versions = manifest["versionOrder"]
    candidates = [version] if version else versions
    for candidate in candidates:
        if candidate not in versions:
            fail(f"Unknown version: {candidate}")
        packets = parse_packets(root, candidate)
        completed = completed_packets(root, candidate)
        if number is not None and candidate == version:
            match = next((packet for packet in packets if packet.number == number), None)
            if not match:
                fail(f"Packet {number} does not exist in {candidate}")
            earlier = {packet.number for packet in packets if packet.number < number}
            if not earlier.issubset(completed):
                fail(f"Packet {number} cannot run before earlier packets are completed in {candidate}")
            if number in completed:
                fail(f"Packet {number} is already complete in {candidate}")
            return match
        match = next((packet for packet in packets if packet.number not in completed), None)
        if match:
            return match
    fail("All roadmap packets are marked complete.")


def choose_agent(root: Path, manifest: dict, packet: Packet, args: argparse.Namespace) -> Agent:
    text = f"{packet.title}\n{packet.body}".lower()
    role = args.role or manifest.get("packetRoles", {}).get(packet.version, {}).get(str(packet.number))
    if not role:
        if any(keyword in text for keyword in manifest["architectKeywords"]):
            role = "architect"
        elif any(keyword in packet.title.lower() for keyword in manifest["routineKeywords"]):
            role = "routine"
        else:
            role = manifest["defaultRole"]
    path = root / ".codex" / "agents" / f"{role}.toml"
    if not path.is_file():
        fail(f"Agent routing file is missing: {path.relative_to(root)}")
    with path.open("rb") as file:
        config = tomllib.load(file)
    model = args.model or config["model"]
    reasoning = args.reasoning or config["reasoning_effort"]
    escalations = {
        "normal": None,
        "terra-high": ("gpt-5.6-terra", "high"),
        "sol-high": ("gpt-5.6-sol", "high"),
        "astra-high": ("gpt-6-astra", "high"),
    }
    escalation = escalations[args.escalation]
    if escalation:
        if role == "routine":
            fail("Routine packets must not escalate automatically; narrow the task or repair it directly.")
        model, reasoning = escalation
    return Agent(role, model, reasoning)


def requires_review(manifest: dict, packet: Packet) -> bool:
    text = f"{packet.title}\n{packet.body}".lower()
    return any(keyword in text for keyword in manifest["reviewKeywords"])


def assert_clean_git(root: Path) -> str:
    if not shutil.which("git"):
        fail("Git is required to run roadmap automation.")
    status = run(["git", "status", "--porcelain"], root, check=True).stdout.strip()
    if status:
        fail("Working tree is not clean. Commit, stash, or explicitly resolve these changes before a packet:\n" + status)
    return run(["git", "rev-parse", "HEAD"], root, check=True).stdout.strip()


def prompt_for(packet: Packet, agent: Agent, review: bool = False) -> str:
    if review:
        return textwrap.dedent(f"""\
            Read only the files relevant to this completed packet:
            - AGENTS.md
            - docs/roadmap/{packet.version}.md
            - docs/progress/{packet.version}.md
            - the packet diff from HEAD~1..HEAD

            Perform a read-only correctness and security review of {packet.version} Packet {packet.number} — {packet.title}.
            Do not edit files. Focus on security, correctness, regressions, and whether the stated verification is credible.
            If it is safe to checkpoint, end with exactly REVIEW_PASS. Otherwise end with ROADMAP_STOP: <exact reason>; HUMAN_ACTION: <exact action>.
        """)
    return textwrap.dedent(f"""\
        Read only:
        - AGENTS.md
        - docs/roadmap/{packet.version}.md
        - docs/progress/{packet.version}.md
        - directly relevant source files after inspecting the repository

        Implement exactly {packet.version} Packet {packet.number} — {packet.title}.
        This is a bounded Codex task. Do not implement later packets or unrelated roadmap versions.
        Follow AGENTS.md, including local-first security and cross-platform rules. Do not require real credentials for automated tests.
        Before editing, inspect only the minimal relevant file set. Run the packet's required verification commands and repair failures caused by your changes.

        If the work requires credentials/developer apps, external audit/review, a destructive migration, a licensing decision, bypassing a platform restriction, a major architecture deviation, a public release, or a publish operation, stop immediately and end with:
        ROADMAP_STOP: <exact reason>; HUMAN_ACTION: <exact action>

        On success, update docs/progress/{packet.version}.md. In its Completed section add exactly:
        - Packet {packet.number} — {packet.title}
        Record concise verification results, the next packet, changed files, and blockers. Stop after this packet.
    """)


def print_dry_run(packet: Packet, agent: Agent, manifest: dict) -> None:
    print(f"Current version: {packet.version}")
    print(f"Next packet: {packet.number} — {packet.title}")
    print(f"Selected role: {agent.role}")
    print(f"Selected model: {agent.model}")
    print(f"Selected reasoning: {agent.reasoning}")
    print(f"Review required: {'yes' if requires_review(manifest, packet) else 'no'}")
    print("Verification commands:")
    for command in manifest["verification"]:
        print(f"- {command}")
    print("Expected prompt:\n" + prompt_for(packet, agent))


def invoke_codex(root: Path, packet: Packet, agent: Agent, review: bool = False) -> str:
    command = [
        "codex", "exec", "--cd", str(root), "--model", agent.model,
        "--config", f'model_reasoning_effort="{agent.reasoning}"',
        "--sandbox", "read-only" if review else "workspace-write",
    ]
    if not review:
        command.append("--approve-for-me")
    command.append(prompt_for(packet, agent, review))
    result = run(command, root)
    output = result.stdout + result.stderr
    print(output, end="" if output.endswith("\n") else "\n")
    if STOP_MARKER in output:
        fail(output[output.index(STOP_MARKER):].splitlines()[0])
    if result.returncode:
        fail(f"Codex task failed with exit code {result.returncode}. Retry only with the next documented escalation level if appropriate.")
    return output


def run_verification(root: Path, manifest: dict) -> None:
    for shell_command in manifest["verification"]:
        executable = shell_command.split()[0]
        if not shutil.which(executable):
            fail(f"Required verification command is unavailable: {shell_command}")
        result = subprocess.run(shell_command, cwd=root, shell=True, text=True)
        if result.returncode:
            fail(f"Verification failed: {shell_command}. The task is not checkpointed; repair it before resuming.")


def git_identity_exists(root: Path) -> bool:
    return bool(run(["git", "config", "user.name"], root).stdout.strip() and run(["git", "config", "user.email"], root).stdout.strip())


def checkpoint(root: Path, packet: Packet, before: str) -> None:
    diff = run(["git", "diff", "--stat", before], root, check=True).stdout.strip()
    print("Diff since packet start:\n" + (diff or "(no diff)"))
    if not git_identity_exists(root):
        print("Git identity is not configured; leaving the verified packet uncommitted.")
        return
    slug = re.sub(r"[^a-z0-9]+", "-", packet.title.lower()).strip("-")[:50]
    run(["git", "add", "-A"], root, check=True)
    run(["git", "commit", "-m", f"feat({packet.version}): complete packet {packet.number} {slug}"], root, check=True)


def execute_one(root: Path, manifest: dict, args: argparse.Namespace) -> None:
    packet = next_packet(root, manifest, args.version, args.packet)
    agent = choose_agent(root, manifest, packet, args)
    if args.dry_run:
        print_dry_run(packet, agent, manifest)
        return
    before = assert_clean_git(root)
    invoke_codex(root, packet, agent)
    if packet.number not in completed_packets(root, packet.version):
        fail(f"The Codex task did not record Packet {packet.number} in docs/progress/{packet.version}.md. Resolve this explicitly before resuming.")
    run_verification(root, manifest)
    if requires_review(manifest, packet):
        reviewer = choose_agent(root, manifest, argparse.Namespace(**{**vars(args), "role": "reviewer", "model": None, "reasoning": None, "escalation": "normal"}))
        review_output = invoke_codex(root, packet, reviewer, review=True)
        if "REVIEW_PASS" not in review_output:
            fail("Reviewer did not emit REVIEW_PASS. Human action is required before checkpointing.")
    checkpoint(root, packet, before)


def self_test(root: Path) -> None:
    manifest = load_manifest(root)
    for version in manifest["versionOrder"]:
        assert parse_packets(root, version), f"No packets in {version}"
        completed_packets(root, version)
    with tempfile.TemporaryDirectory() as directory:
        fake = Path(directory)
        (fake / "docs" / "roadmap").mkdir(parents=True)
        (fake / "docs" / "progress").mkdir(parents=True)
        (fake / ".codex" / "agents").mkdir(parents=True)
        (fake / "scripts").mkdir()
        (fake / "scripts" / "roadmap.json").write_text(json.dumps({**manifest, "versionOrder": ["v0.1", "v0.2"]}), encoding="utf-8")
        for role in ("architect", "builder", "routine", "reviewer"):
            shutil.copy2(root / ".codex" / "agents" / f"{role}.toml", fake / ".codex" / "agents" / f"{role}.toml")
        (fake / "docs" / "roadmap" / "v0.1.md").write_text("### Packet 1 — Repository tooling\n", encoding="utf-8")
        (fake / "docs" / "roadmap" / "v0.2.md").write_text("### Packet 1 — OAuth adapter\n", encoding="utf-8")
        (fake / "docs" / "progress" / "v0.1.md").write_text("## Completed\n- Packet 1 — Repository tooling\n", encoding="utf-8")
        (fake / "docs" / "progress" / "v0.2.md").write_text("## Completed\n- None yet.\n", encoding="utf-8")
        packet = next_packet(fake, load_manifest(fake), None, None)
        assert (packet.version, packet.number) == ("v0.2", 1), "resume did not select next version"
        agent = choose_agent(fake, load_manifest(fake), packet, argparse.Namespace(role=None, model=None, reasoning=None, escalation="normal"))
        assert agent.role == "architect" and agent.model == "gpt-5.6-sol", "OAuth routing failed"
    print("Self-test passed: roadmap discovery, packet parsing, routing, and mocked resume.")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subparsers = command.add_subparsers(dest="command", required=True)
    for name in ("roadmap", "packet"):
        item = subparsers.add_parser(name)
        item.add_argument("--version")
        item.add_argument("--packet", type=int)
        item.add_argument("--dry-run", action="store_true")
        item.add_argument("--model")
        item.add_argument("--reasoning", choices=("low", "medium", "high"))
        item.add_argument("--role", choices=("architect", "builder", "routine"))
        item.add_argument("--escalation", choices=("normal", "terra-high", "sol-high", "astra-high"), default="normal")
    subparsers.add_parser("self-test")
    return command


def main() -> None:
    args = parser().parse_args()
    root = repo_root()
    if args.command == "self-test":
        self_test(root)
        return
    manifest = load_manifest(root)
    if args.command == "packet" and (not args.version or args.packet is None):
        fail("packet requires --version and --packet")
    execute_one(root, manifest, args)


if __name__ == "__main__":
    main()
