import Joi from 'joi';
import config from '../../utils/config.js';
import { isValidLanguageId } from '../../languages/index.js';

// Submission validation schema
const submissionSchema = Joi.object({
  source_code: Joi.string().required().max(config.execution.maxSourceSize),
  language_id: Joi.number().integer().required().custom((value, helpers) => {
    if (!isValidLanguageId(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  stdin: Joi.string().allow('', null).default(''),
  expected_output: Joi.string().allow('', null).default(null),
  cpu_time_limit: Joi.number().min(0).max(config.execution.maxCpuTimeLimit)
    .default(config.execution.defaultCpuTimeLimit),
  cpu_extra_time: Joi.number().min(0).max(5).default(1),
  wall_time_limit: Joi.number().min(0).max(config.execution.maxWallTimeLimit)
    .default(config.execution.defaultWallTimeLimit),
  memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit)
    .default(config.execution.defaultMemoryLimit),
  stack_limit: Joi.number().min(0).max(config.execution.defaultStackLimit)
    .default(config.execution.defaultStackLimit),
  max_processes_and_or_threads: Joi.number().min(1).max(config.execution.maxProcesses)
    .default(config.execution.maxProcesses),
  max_file_size: Joi.number().min(0).max(4096).default(1024),
  compiler_options: Joi.string().allow('', null).default(null),
  command_line_arguments: Joi.string().allow('', null).default(null),
  redirect_stderr_to_stdout: Joi.boolean().default(false),
  enable_network: Joi.boolean().default(false),
  callback_url: Joi.string().uri().allow('', null).default(null),
  additional_files: Joi.string().allow('', null).max(config.execution.maxAdditionalFilesSize).default(null),
});

// Batch submission validation
const batchSubmissionSchema = Joi.object({
  submissions: Joi.array().items(submissionSchema).min(1).max(20).required(),
});

/**
 * Validate submission request
 */
export function validateSubmission(req, res, next) {
  const { error, value } = submissionSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

/**
 * Validate batch submission request
 */
export function validateBatchSubmission(req, res, next) {
  const { error, value } = batchSubmissionSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

/**
 * Sanitize compiler options to prevent command injection
 */
export function sanitizeCompilerOptions(options) {
  if (!options) return null;
  // Remove potentially dangerous characters
  return options.replace(/[$&;<>`|(){}[\]!#*?~]/g, '');
}

/**
 * Sanitize command line arguments
 */
export function sanitizeCommandLineArgs(args) {
  if (!args) return null;
  // Remove potentially dangerous characters but allow common argument patterns
  return args.replace(/[$&;<>`|(){}[\]!#*?~]/g, '');
}

export default {
  validateSubmission,
  validateBatchSubmission,
  sanitizeCompilerOptions,
  sanitizeCommandLineArgs,
};
