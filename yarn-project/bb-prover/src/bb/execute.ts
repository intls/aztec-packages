import { type AvmCircuitInputs } from '@aztec/circuits.js';
import { sha256 } from '@aztec/foundation/crypto';
import { type LogFn, type Logger } from '@aztec/foundation/log';
import { Timer } from '@aztec/foundation/timer';
import { type NoirCompiledCircuit } from '@aztec/types/noir';

import * as proc from 'child_process';
import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

import { type UltraHonkFlavor } from '../honk.js';

export const VK_FILENAME = 'vk';
export const VK_FIELDS_FILENAME = 'vk_fields.json';
export const PROOF_FILENAME = 'proof';
export const PROOF_FIELDS_FILENAME = 'proof_fields.json';
export const AVM_BYTECODE_FILENAME = 'avm_bytecode.bin';
export const AVM_PUBLIC_INPUTS_FILENAME = 'avm_public_inputs.bin';
export const AVM_HINTS_FILENAME = 'avm_hints.bin';

export enum BB_RESULT {
  SUCCESS,
  FAILURE,
  ALREADY_PRESENT,
}

export type BBSuccess = {
  status: BB_RESULT.SUCCESS | BB_RESULT.ALREADY_PRESENT;
  durationMs: number;
  /** Full path of the public key. */
  pkPath?: string;
  /** Base directory for the VKs (raw, fields). */
  vkPath?: string;
  /** Full path of the proof. */
  proofPath?: string;
  /** Full path of the contract. */
  contractPath?: string;
  /** The number of gates in the circuit. */
  circuitSize?: number;
};

export type BBFailure = {
  status: BB_RESULT.FAILURE;
  reason: string;
  retry?: boolean;
};

export type BBResult = BBSuccess | BBFailure;

export type VerificationFunction = typeof verifyProof | typeof verifyAvmProof;

type BBExecResult = {
  status: BB_RESULT;
  exitCode: number;
  signal: string | undefined;
};

/**
 * Invokes the Barretenberg binary with the provided command and args
 * @param pathToBB - The path to the BB binary
 * @param command - The command to execute
 * @param args - The arguments to pass
 * @param logger - A log function
 * @param resultParser - An optional handler for detecting success or failure
 * @returns The completed partial witness outputted from the circuit
 */
export function executeBB(
  pathToBB: string,
  command: string,
  args: string[],
  logger: LogFn,
  resultParser = (code: number) => code === 0,
): Promise<BBExecResult> {
  return new Promise<BBExecResult>(resolve => {
    // spawn the bb process
    const { HARDWARE_CONCURRENCY: _, ...envWithoutConcurrency } = process.env;
    const env = process.env.HARDWARE_CONCURRENCY ? process.env : envWithoutConcurrency;
    logger(`Executing BB with: ${command} ${args.join(' ')}`);
    const bb = proc.spawn(pathToBB, [command, ...args], {
      env,
    });
    bb.stdout.on('data', data => {
      const message = data.toString('utf-8').replace(/\n$/, '');
      logger(message);
    });
    bb.stderr.on('data', data => {
      const message = data.toString('utf-8').replace(/\n$/, '');
      logger(message);
    });
    bb.on('close', (exitCode: number, signal?: string) => {
      if (resultParser(exitCode)) {
        resolve({ status: BB_RESULT.SUCCESS, exitCode, signal });
      } else {
        resolve({ status: BB_RESULT.FAILURE, exitCode, signal });
      }
    });
  }).catch(_ => ({ status: BB_RESULT.FAILURE, exitCode: -1, signal: undefined }));
}

const bytecodeFilename = 'bytecode';

/**
 * Used for generating either a proving or verification key, will exit early if the key already exists
 * It assumes the provided working directory is one where the caller wishes to maintain a permanent set of keys
 * It is not considered a temporary directory
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - The directory into which the key should be created
 * @param circuitName - An identifier for the circuit
 * @param compiledCircuit - The compiled circuit
 * @param key - The type of key, either 'pk' or 'vk'
 * @param log - A logging function
 * @param force - Force the key to be regenerated even if it already exists
 * @returns An instance of BBResult
 */
export async function generateKeyForNoirCircuit(
  pathToBB: string,
  workingDirectory: string,
  circuitName: string,
  compiledCircuit: NoirCompiledCircuit,
  recursive: boolean,
  flavor: UltraHonkFlavor,
  log: LogFn,
  force = false,
): Promise<BBSuccess | BBFailure> {
  const bytecode = Buffer.from(compiledCircuit.bytecode, 'base64');

  // The key generation is written to e.g. /workingDirectory/pk/BaseParityArtifact/pk
  // The bytecode hash file is also written here as /workingDirectory/pk/BaseParityArtifact/bytecode-hash
  // The bytecode is written to e.g. /workingDirectory/pk/BaseParityArtifact/bytecode
  // The bytecode is removed after the key is generated, leaving just the hash file
  const circuitOutputDirectory = `${workingDirectory}/vk/${circuitName}`;
  const outputPath = `${circuitOutputDirectory}`;
  const bytecodeHash = sha256(bytecode);

  // ensure the directory exists
  await fs.mkdir(circuitOutputDirectory, { recursive: true });

  const res = await fsCache<BBSuccess | BBFailure>(circuitOutputDirectory, bytecodeHash, log, force, async () => {
    const binaryPresent = await fs
      .access(pathToBB, fs.constants.R_OK)
      .then(_ => true)
      .catch(_ => false);
    if (!binaryPresent) {
      return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
    }

    // We are now going to generate the key
    try {
      const bytecodePath = `${circuitOutputDirectory}/${bytecodeFilename}`;
      // Write the bytecode to the working directory
      await fs.writeFile(bytecodePath, bytecode);

      // args are the output path and the input bytecode path
      const args = ['-o', `${outputPath}/${VK_FILENAME}`, '-b', bytecodePath, recursive ? '--recursive' : ''];
      const timer = new Timer();
      let result = await executeBB(pathToBB, `write_vk_${flavor}`, args, log);

      // If we succeeded and the type of key if verification, have bb write the 'fields' version too
      if (result.status == BB_RESULT.SUCCESS) {
        const asFieldsArgs = ['-k', `${outputPath}/${VK_FILENAME}`, '-o', `${outputPath}/${VK_FIELDS_FILENAME}`, '-v'];
        result = await executeBB(pathToBB, `vk_as_fields_${flavor}`, asFieldsArgs, log);
      }
      const duration = timer.ms();

      if (result.status == BB_RESULT.SUCCESS) {
        return {
          status: BB_RESULT.SUCCESS,
          durationMs: duration,
          pkPath: undefined,
          vkPath: outputPath,
          proofPath: undefined,
        };
      }
      // Not a great error message here but it is difficult to decipher what comes from bb
      return {
        status: BB_RESULT.FAILURE,
        reason: `Failed to generate key. Exit code: ${result.exitCode}. Signal ${result.signal}.`,
        retry: !!result.signal,
      };
    } catch (error) {
      return { status: BB_RESULT.FAILURE, reason: `${error}` };
    }
  });

  if (!res) {
    return {
      status: BB_RESULT.ALREADY_PRESENT,
      durationMs: 0,
      pkPath: undefined,
      vkPath: outputPath,
    };
  }

  return res;
}

// TODO(#7369) comment this etc (really just take inspiration from this and rewrite it all O:))
export async function executeBbClientIvcProof(
  pathToBB: string,
  workingDirectory: string,
  bytecodeStackPath: string,
  witnessStackPath: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // The proof is written to e.g. /workingDirectory/proof
  const outputPath = `${workingDirectory}`;

  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    // Write the bytecode to the working directory
    log(`bytecodePath ${bytecodeStackPath}`);
    log(`outputPath ${outputPath}`);
    const args = [
      '-o',
      outputPath,
      '-b',
      bytecodeStackPath,
      '-w',
      witnessStackPath,
      '-v',
      '--scheme',
      'client_ivc',
      '--input_type',
      'runtime_stack',
    ];

    const timer = new Timer();
    const logFunction = (message: string) => {
      log(`bb - ${message}`);
    };

    const result = await executeBB(pathToBB, 'prove', args, logFunction);
    const durationMs = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      return {
        status: BB_RESULT.SUCCESS,
        durationMs,
        proofPath: `${outputPath}`,
        pkPath: undefined,
        vkPath: `${outputPath}`,
      };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to generate proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for generating verification keys of noir circuits.
 * It is assumed that the working directory is a temporary and/or random directory used solely for generating this VK.
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - A working directory for use by bb
 * @param circuitName - An identifier for the circuit
 * @param bytecode - The compiled circuit bytecode
 * @param inputWitnessFile - The circuit input witness
 * @param log - A logging function
 * @returns An object containing a result indication, the location of the VK and the duration taken
 */
export async function computeVerificationKey(
  pathToBB: string,
  workingDirectory: string,
  circuitName: string,
  bytecode: Buffer,
  recursive: boolean,
  flavor: UltraHonkFlavor | 'mega_honk',
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // The bytecode is written to e.g. /workingDirectory/BaseParityArtifact-bytecode
  const bytecodePath = `${workingDirectory}/${circuitName}-bytecode`;

  // The verification key is written to this path
  const outputPath = `${workingDirectory}/vk`;

  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    // Write the bytecode to the working directory
    await fs.writeFile(bytecodePath, bytecode);
    const timer = new Timer();
    const logFunction = (message: string) => {
      log(`computeVerificationKey(${circuitName}) BB out - ${message}`);
    };
    const args = ['-o', outputPath, '-b', bytecodePath, '-v', recursive ? '--recursive' : ''];
    let result = await executeBB(pathToBB, `write_vk_${flavor}`, args, logFunction);
    if (result.status == BB_RESULT.FAILURE) {
      return { status: BB_RESULT.FAILURE, reason: 'Failed writing VK.' };
    }
    result = await executeBB(
      pathToBB,
      `vk_as_fields_${flavor}`,
      ['-o', outputPath + '_fields.json', '-k', outputPath, '-v'],
      logFunction,
    );
    const duration = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      return {
        status: BB_RESULT.SUCCESS,
        durationMs: duration,
        pkPath: undefined,
        vkPath: `${outputPath}`,
      };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to write VK. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for generating proofs of noir circuits.
 * It is assumed that the working directory is a temporary and/or random directory used solely for generating this proof.
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - A working directory for use by bb
 * @param circuitName - An identifier for the circuit
 * @param bytecode - The compiled circuit bytecode
 * @param inputWitnessFile - The circuit input witness
 * @param log - A logging function
 * @returns An object containing a result indication, the location of the proof and the duration taken
 */
export async function generateProof(
  pathToBB: string,
  workingDirectory: string,
  circuitName: string,
  bytecode: Buffer,
  recursive: boolean,
  inputWitnessFile: string,
  flavor: UltraHonkFlavor,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // The bytecode is written to e.g. /workingDirectory/BaseParityArtifact-bytecode
  const bytecodePath = `${workingDirectory}/${circuitName}-bytecode`;

  // The proof is written to e.g. /workingDirectory/ultra_honk/proof
  const outputPath = `${workingDirectory}`;

  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    // Write the bytecode to the working directory
    await fs.writeFile(bytecodePath, bytecode);
    const args = ['-o', outputPath, '-b', bytecodePath, '-w', inputWitnessFile, '-v', recursive ? '--recursive' : ''];
    const timer = new Timer();
    const logFunction = (message: string) => {
      log(`${circuitName} BB out - ${message}`);
    };
    const result = await executeBB(pathToBB, `prove_${flavor}_output_all`, args, logFunction);
    const duration = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      return {
        status: BB_RESULT.SUCCESS,
        durationMs: duration,
        proofPath: `${outputPath}`,
        pkPath: undefined,
        vkPath: `${outputPath}`,
      };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to generate proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for generating proofs of the tube circuit
 * It is assumed that the working directory is a temporary and/or random directory used solely for generating this proof.
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - A working directory for use by bb
 * @param circuitName - An identifier for the circuit
 * @param bytecode - The compiled circuit bytecode
 * @param inputWitnessFile - The circuit input witness
 * @param log - A logging function
 * @returns An object containing a result indication, the location of the proof and the duration taken
 */
export async function generateTubeProof(
  pathToBB: string,
  workingDirectory: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // // Paths for the inputs
  const vkPath = join(workingDirectory, 'client_ivc_vk.bin');
  const proofPath = join(workingDirectory, 'client_ivc_proof.bin');

  // The proof is written to e.g. /workingDirectory/proof
  const outputPath = workingDirectory;
  const filePresent = async (file: string) =>
    await fs
      .access(file, fs.constants.R_OK)
      .then(_ => true)
      .catch(_ => false);

  const binaryPresent = await filePresent(pathToBB);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    if (!filePresent(vkPath) || !filePresent(proofPath)) {
      return { status: BB_RESULT.FAILURE, reason: `Client IVC input files not present in  ${workingDirectory}` };
    }
    const args = ['-o', outputPath, '-v'];

    const timer = new Timer();
    const logFunction = (message: string) => {
      log(`TubeCircuit (prove) BB out - ${message}`);
    };
    const result = await executeBB(pathToBB, 'prove_tube', args, logFunction);
    const durationMs = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      return {
        status: BB_RESULT.SUCCESS,
        durationMs,
        proofPath: outputPath,
        pkPath: undefined,
        vkPath: outputPath,
      };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to generate proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for generating AVM proofs.
 * It is assumed that the working directory is a temporary and/or random directory used solely for generating this proof.
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - A working directory for use by bb
 * @param bytecode - The AVM bytecode for the public function to be proven (expected to be decompressed)
 * @param log - A logging function
 * @returns An object containing a result indication, the location of the proof and the duration taken
 */
export async function generateAvmProof(
  pathToBB: string,
  workingDirectory: string,
  input: AvmCircuitInputs,
  logger: Logger,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // Paths for the inputs
  const publicInputsPath = join(workingDirectory, AVM_PUBLIC_INPUTS_FILENAME);
  const avmHintsPath = join(workingDirectory, AVM_HINTS_FILENAME);

  // The proof is written to e.g. /workingDirectory/proof
  const outputPath = workingDirectory;

  const filePresent = async (file: string) =>
    await fs
      .access(file, fs.constants.R_OK)
      .then(_ => true)
      .catch(_ => false);

  const binaryPresent = await filePresent(pathToBB);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    // Write the inputs to the working directory.

    await fs.writeFile(publicInputsPath, input.output.toBuffer());
    if (!filePresent(publicInputsPath)) {
      return { status: BB_RESULT.FAILURE, reason: `Could not write publicInputs at ${publicInputsPath}` };
    }

    await fs.writeFile(avmHintsPath, input.avmHints.toBuffer());
    if (!filePresent(avmHintsPath)) {
      return { status: BB_RESULT.FAILURE, reason: `Could not write avmHints at ${avmHintsPath}` };
    }

    const args = [
      '--avm-public-inputs',
      publicInputsPath,
      '--avm-hints',
      avmHintsPath,
      '-o',
      outputPath,
      logger.level === 'debug' || logger.level === 'trace' ? '-d' : logger.level === 'verbose' ? '-v' : '',
    ];
    const timer = new Timer();
    const logFunction = (message: string) => {
      logger.verbose(`AvmCircuit (prove) BB out - ${message}`);
    };
    const result = await executeBB(pathToBB, 'avm_prove', args, logFunction);
    const duration = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      return {
        status: BB_RESULT.SUCCESS,
        durationMs: duration,
        proofPath: join(outputPath, PROOF_FILENAME),
        pkPath: undefined,
        vkPath: outputPath,
      };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to generate proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for verifying proofs of noir circuits
 * @param pathToBB - The full path to the bb binary
 * @param proofFullPath - The full path to the proof to be verified
 * @param verificationKeyPath - The full path to the circuit verification key
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
export async function verifyProof(
  pathToBB: string,
  proofFullPath: string,
  verificationKeyPath: string,
  ultraHonkFlavor: UltraHonkFlavor,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  return await verifyProofInternal(pathToBB, proofFullPath, verificationKeyPath, `verify_${ultraHonkFlavor}`, log);
}

/**
 * Used for verifying proofs of the AVM
 * @param pathToBB - The full path to the bb binary
 * @param proofFullPath - The full path to the proof to be verified
 * @param verificationKeyPath - The full path to the circuit verification key
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
export async function verifyAvmProof(
  pathToBB: string,
  proofFullPath: string,
  verificationKeyPath: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  return await verifyProofInternal(pathToBB, proofFullPath, verificationKeyPath, 'avm_verify', log);
}

/**
 * Verifies a ClientIvcProof
 * TODO(#7370) The verification keys should be supplied separately
 * @param pathToBB - The full path to the bb binary
 * @param targetPath - The path to the folder with the proof, accumulator, and verification keys
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
export async function verifyClientIvcProof(
  pathToBB: string,
  targetPath: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    const args = ['-o', targetPath, '--scheme', 'client_ivc'];
    const timer = new Timer();
    const command = 'verify';
    const result = await executeBB(pathToBB, command, args, log);
    const duration = timer.ms();
    if (result.status == BB_RESULT.SUCCESS) {
      return { status: BB_RESULT.SUCCESS, durationMs: duration };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to verify proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for verifying proofs with BB
 * @param pathToBB - The full path to the bb binary
 * @param proofFullPath - The full path to the proof to be verified
 * @param verificationKeyPath - The full path to the circuit verification key
 * @param command - The BB command to execute (verify/avm_verify)
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
async function verifyProofInternal(
  pathToBB: string,
  proofFullPath: string,
  verificationKeyPath: string,
  command: 'verify_ultra_honk' | 'verify_ultra_keccak_honk' | 'avm_verify',
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    const args = ['-p', proofFullPath, '-k', verificationKeyPath];
    const timer = new Timer();
    const result = await executeBB(pathToBB, command, args, log);
    const duration = timer.ms();
    if (result.status == BB_RESULT.SUCCESS) {
      return { status: BB_RESULT.SUCCESS, durationMs: duration };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to verify proof. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for verifying proofs of noir circuits
 * @param pathToBB - The full path to the bb binary
 * @param verificationKeyPath - The directory containing the binary verification key
 * @param verificationKeyFilename - The filename of the verification key
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
export async function writeVkAsFields(
  pathToBB: string,
  verificationKeyPath: string,
  verificationKeyFilename: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    const args = ['-k', `${verificationKeyPath}/${verificationKeyFilename}`, '-v'];
    const timer = new Timer();
    const result = await executeBB(pathToBB, 'vk_as_fields_ultra_honk', args, log);
    const duration = timer.ms();
    if (result.status == BB_RESULT.SUCCESS) {
      return { status: BB_RESULT.SUCCESS, durationMs: duration, vkPath: verificationKeyPath };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to create vk as fields. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

/**
 * Used for verifying proofs of noir circuits
 * @param pathToBB - The full path to the bb binary
 * @param proofPath - The directory containing the binary proof
 * @param proofFileName - The filename of the proof
 * @param vkFileName - The filename of the verification key
 * @param log - A logging function
 * @returns An object containing a result indication and duration taken
 */
export async function writeProofAsFields(
  pathToBB: string,
  proofPath: string,
  proofFileName: string,
  vkFilePath: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  try {
    const args = ['-p', `${proofPath}/${proofFileName}`, '-k', vkFilePath, '-v'];
    const timer = new Timer();
    const result = await executeBB(pathToBB, 'proof_as_fields_honk', args, log);
    const duration = timer.ms();
    if (result.status == BB_RESULT.SUCCESS) {
      return { status: BB_RESULT.SUCCESS, durationMs: duration, proofPath: proofPath };
    }
    // Not a great error message here but it is difficult to decipher what comes from bb
    return {
      status: BB_RESULT.FAILURE,
      reason: `Failed to create proof as fields. Exit code ${result.exitCode}. Signal ${result.signal}.`,
      retry: !!result.signal,
    };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

export async function generateContractForVerificationKey(
  pathToBB: string,
  vkFilePath: string,
  contractPath: string,
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);

  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  const outputDir = dirname(contractPath);
  const contractName = basename(contractPath);
  // cache contract generation based on vk file and contract name
  const cacheKey = sha256(Buffer.concat([Buffer.from(contractName), await fs.readFile(vkFilePath)]));

  await fs.mkdir(outputDir, { recursive: true });

  const res = await fsCache<BBSuccess | BBFailure>(outputDir, cacheKey, log, false, async () => {
    try {
      const args = ['-k', vkFilePath, '-o', contractPath, '-v'];
      const timer = new Timer();
      const result = await executeBB(pathToBB, 'contract_ultra_honk', args, log);
      const duration = timer.ms();
      if (result.status == BB_RESULT.SUCCESS) {
        return { status: BB_RESULT.SUCCESS, durationMs: duration, contractPath };
      }
      // Not a great error message here but it is difficult to decipher what comes from bb
      return {
        status: BB_RESULT.FAILURE,
        reason: `Failed to write verifier contract. Exit code ${result.exitCode}. Signal ${result.signal}.`,
        retry: !!result.signal,
      };
    } catch (error) {
      return { status: BB_RESULT.FAILURE, reason: `${error}` };
    }
  });

  if (!res) {
    return {
      status: BB_RESULT.ALREADY_PRESENT,
      durationMs: 0,
      contractPath,
    };
  }

  return res;
}

export async function generateContractForCircuit(
  pathToBB: string,
  workingDirectory: string,
  circuitName: string,
  compiledCircuit: NoirCompiledCircuit,
  contractName: string,
  log: LogFn,
  force = false,
) {
  // Verifier contracts are never recursion friendly, because non-recursive proofs are generated using the keccak256 hash function.
  // We need to use the same hash function during verification so proofs generated using keccak256 are cheap to verify on ethereum
  // (where the verifier contract would be deployed) whereas if we want to verify the proof within a snark (for recursion) we want
  // to use a snark-friendly hash function.
  const recursive = false;

  const vkResult = await generateKeyForNoirCircuit(
    pathToBB,
    workingDirectory,
    circuitName,
    compiledCircuit,
    recursive,
    'ultra_keccak_honk',
    log,
    force,
  );
  if (vkResult.status === BB_RESULT.FAILURE) {
    return vkResult;
  }

  return generateContractForVerificationKey(
    pathToBB,
    join(vkResult.vkPath!, VK_FILENAME),
    join(workingDirectory, 'contract', circuitName, contractName),
    log,
  );
}

/**
 * Compute bb gate count for a given circuit
 * @param pathToBB - The full path to the bb binary
 * @param workingDirectory - A temporary directory for writing the bytecode
 * @param circuitName - The name of the circuit
 * @param bytecode - The bytecode of the circuit
 * @param flavor - The flavor of the backend - mega_honk or ultra_honk variants
 * @returns An object containing the status, gate count, and time taken
 */
export async function computeGateCountForCircuit(
  pathToBB: string,
  workingDirectory: string,
  circuitName: string,
  bytecode: Buffer,
  flavor: UltraHonkFlavor | 'mega_honk',
  log: LogFn,
): Promise<BBFailure | BBSuccess> {
  // Check that the working directory exists
  try {
    await fs.access(workingDirectory);
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `Working directory ${workingDirectory} does not exist` };
  }

  // The bytecode is written to e.g. /workingDirectory/BaseParityArtifact-bytecode
  const bytecodePath = `${workingDirectory}/${circuitName}-bytecode`;

  const binaryPresent = await fs
    .access(pathToBB, fs.constants.R_OK)
    .then(_ => true)
    .catch(_ => false);
  if (!binaryPresent) {
    return { status: BB_RESULT.FAILURE, reason: `Failed to find bb binary at ${pathToBB}` };
  }

  // Accumulate the stdout from bb
  let stdout = '';
  const logHandler = (message: string) => {
    stdout += message;
    log(message);
  };

  try {
    // Write the bytecode to the working directory
    await fs.writeFile(bytecodePath, bytecode);
    const timer = new Timer();

    const result = await executeBB(
      pathToBB,
      flavor === 'mega_honk' ? `gates_for_ivc` : `gates`,
      ['-b', bytecodePath, '-v'],
      logHandler,
    );
    const duration = timer.ms();

    if (result.status == BB_RESULT.SUCCESS) {
      // Look for "circuit_size" in the stdout and parse the number
      const circuitSizeMatch = stdout.match(/circuit_size": (\d+)/);
      if (!circuitSizeMatch) {
        return { status: BB_RESULT.FAILURE, reason: 'Failed to parse circuit_size from bb gates stdout.' };
      }
      const circuitSize = parseInt(circuitSizeMatch[1]);

      return {
        status: BB_RESULT.SUCCESS,
        durationMs: duration,
        circuitSize: circuitSize,
      };
    }

    return { status: BB_RESULT.FAILURE, reason: 'Failed getting the gate count.' };
  } catch (error) {
    return { status: BB_RESULT.FAILURE, reason: `${error}` };
  }
}

const CACHE_FILENAME = '.cache';
async function fsCache<T>(
  dir: string,
  expectedCacheKey: Buffer,
  logger: LogFn,
  force: boolean,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const cacheFilePath = join(dir, CACHE_FILENAME);

  let run: boolean;
  if (force) {
    run = true;
  } else {
    try {
      run = !expectedCacheKey.equals(await fs.readFile(cacheFilePath));
    } catch (err: any) {
      if (err && 'code' in err && err.code === 'ENOENT') {
        // cache file doesn't exist, swallow error and run
        run = true;
      } else {
        throw err;
      }
    }
  }

  let res: T | undefined;
  if (run) {
    logger(`Cache miss or forced run. Running operation in ${dir}...`);
    res = await action();
  } else {
    logger(`Cache hit. Skipping operation in ${dir}...`);
  }

  try {
    await fs.writeFile(cacheFilePath, expectedCacheKey);
  } catch (err) {
    logger(`Couldn't write cache data to ${cacheFilePath}. Skipping cache...`);
    // ignore
  }

  return res;
}
