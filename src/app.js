const express = require('express');
const bodyParser = require('body-parser');
const { sequelize } = require('./model');
const { getProfile } = require('./middleware/getProfile');
const { Op } = require('sequelize');
const { percentage, isValidDate } = require('./utils');
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

/**
 * @returns contract by id filtered by profile_id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
  const { Contract } = req.app.get('models');
  const { id: contractId } = req.params;
  const { id: profileId } = req.profile;
  const contract = await Contract.findOne({
    where: {
      id: contractId,
      [Op.or]: { ClientId: profileId, ContractorId: profileId },
    },
  });
  if (!contract) return res.status(404).end();
  res.json(contract);
});

/**
 * @returns a list of non-terminated contracts filtered by profile_id
 */
app.get('/contracts', getProfile, async (req, res) => {
  const { Contract } = req.app.get('models');
  const { id: profileId } = req.profile;

  const contracts = await Contract.findAll({
    where: {
      status: { [Op.ne]: 'terminated' },
      [Op.or]: { ClientId: profileId, ContractorId: profileId },
    },
  });

  res.json(contracts);
});

/**
 * @returns a list of unpaid jobs for a user (only in_progress contracts)
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get('models');
  const { id: profileId } = req.profile;

  const unpaidJobs = await Job.findAll({
    where: {
      paid: { [Op.is]: null },
    },
    include: {
      model: Contract,
      where: {
        status: { [Op.eq]: 'in_progress' },
        [Op.or]: { ClientId: profileId, ContractorId: profileId },
      },
    },
  });

  res.json(unpaidJobs);
});

/**
 * Pay for a job
 * A client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get('models');
  const { job_id: jobId } = req.params;
  const { id: profileId } = req.profile;

  try {
    await sequelize.transaction(async (t) => {
      // Try to get the unpaid job that belongs to an active contract of the client (not contractor) authenticated
      const jobToPay = await Job.findOne(
        {
          where: {
            id: jobId,
            paid: { [Op.is]: null },
          },
          include: {
            model: Contract,
            where: {
              status: { [Op.eq]: 'in_progress' },
              ClientId: profileId,
            },
            include: {
              model: Profile,
              as: 'Client',
              where: {
                id: profileId,
              },
            },
          },
        },
        { transaction: t }
      );

      if (!jobToPay) {
        throw new Error('Job does not exist for authenticated user');
      }
      // Check if the client's balance is enough to pay for the job
      const clientBalance = jobToPay.Contract.Client.balance;
      if (clientBalance < jobToPay.price) {
        throw new Error('Client does not have enough money to pay for the job');
      }
      // Pay the job and update the balances
      await Job.update(
        { paid: true, paymentDate: new Date() },
        {
          where: {
            id: jobToPay.id,
          },
        },
        { transaction: t }
      );
      await Profile.decrement(
        { balance: jobToPay.price },
        { where: { id: jobToPay.Contract.Client.id } },
        { transaction: t }
      );
      await Profile.increment(
        { balance: jobToPay.price },
        { where: { id: jobToPay.Contract.ContractorId } },
        { transaction: t }
      );
    });

    res.json({ message: 'Job paid succesfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Deposits money into the balance of a client
 * A client can't deposit more than 25% of his total of jobs to pay
 */
app.post('/balances/deposit/:user_id', async (req, res) => {
  // I'm assuming anyone can deposit money into a client's balance (no middleware for this endpoint)
  const { Job, Contract, Profile } = req.app.get('models');
  const { user_id: clientId } = req.params;
  const { amount } = req.body;

  const clientBalance = await Profile.findOne({
    attributes: ['balance'],
    where: { id: clientId, type: 'client' },
  });
  if (!clientBalance) {
    return res.status(404).json({ error: 'User not found' });
  }

  const unpaidJobsTotal = await Job.sum('price', {
    where: {
      paid: { [Op.is]: null },
    },
    include: {
      model: Contract,
      where: {
        status: { [Op.eq]: 'in_progress' },
        ClientId: clientId,
      },
    },
  });

  if (!unpaidJobsTotal) {
    return res
      .status(400)
      .json({ error: 'This user cannot receive money at the moment' });
  }

  const twentyFivePercent = percentage(25, unpaidJobsTotal);
  if (amount > twentyFivePercent) {
    return res.status(400).json({
      error:
        'User cannot receive this amount of money at the moment. Contact me for further details',
    });
  }

  await Profile.increment({ balance: amount }, { where: { id: clientId } });

  res.json({ message: 'Amount deposited on client account successfully' });
});

/**
 * @returns the profession that earned the most money (sum of jobs paid)
 * for any contractor that worked in the query time range
 */
app.get('/admin/best-profession', async (req, res) => {
  // Who can be an admin to call this endpoint? I'm assuming anyone (no middleware)
  const { start, end } = req.query;
  if ((start && !isValidDate(start)) || (end && !isValidDate(end))) {
    return res
      .status(400)
      .json({ error: 'Date parameters should be in format YYYY-MM-DD' });
  }

  const { Job, Contract, Profile } = req.app.get('models');

  const bestProfession = await Job.findAll({
    attributes: [
      'Contract.Contractor.profession',
      [sequelize.fn('SUM', sequelize.col('price')), 'sum_paid_jobs'],
    ],
    where: {
      paid: {
        [Op.is]: true,
      },
      paymentDate: {
        [Op.between]: [
          start ? new Date(start) : new Date(),
          end ? new Date(end) : new Date(),
        ],
      },
    },
    include: {
      model: Contract,
      required: true,
      include: {
        model: Profile,
        as: 'Contractor',
        where: {
          type: 'contractor',
        },
        attributes: ['profession'],
      },
    },
    group: 'Contract.Contractor.profession',
    order: [['sum_paid_jobs', 'DESC']],
    limit: 1,
  });

  if (bestProfession.length === 0) {
    return res
      .status(400)
      .json({ error: 'No jobs found in the range provided' });
  }

  res.json({
    message: `The best profession is ${bestProfession[0].Contract.Contractor.profession}`,
  });
});

/**
 * @returns the clients the paid the most for jobs in the query time period.
 * limit query parameter should be applied, default limit is 2
 */
app.get('/admin/best-clients', async (req, res) => {
  // Who can be an admin to call this endpoint? I'm assuming anyone (no middleware)
  const { start, end, limit } = req.query;
  if ((start && !isValidDate(start)) || (end && !isValidDate(end))) {
    return res
      .status(400)
      .json({ error: 'Date parameters should be in format YYYY-MM-DD' });
  }

  const { Job, Contract, Profile } = req.app.get('models');

  const bestClients = await Job.findAll({
    attributes: [
      'Contract.Client.firstName',
      [sequelize.fn('SUM', sequelize.col('price')), 'sum_paid_jobs'],
    ],
    where: {
      paid: {
        [Op.is]: true,
      },
      paymentDate: {
        [Op.between]: [
          start ? new Date(start) : new Date(),
          end ? new Date(end) : new Date(),
        ],
      },
    },
    include: {
      model: Contract,
      required: true,
      include: {
        model: Profile,
        as: 'Client',
        where: {
          type: 'client',
        },
      },
    },
    group: 'Contract.Client.firstName',
    order: [['sum_paid_jobs', 'DESC']],
    limit: limit || 2,
  });

  if (bestClients.length === 0) {
    return res
      .status(400)
      .json({ error: 'No jobs found in the range provided' });
  }

  const response = bestClients.map((client) => ({
    id: client.Contract.Client.id,
    fullName: `${client.Contract.Client.firstName} ${client.Contract.Client.lastName}`,
    paid: client.dataValues.sum_paid_jobs,
  }));
  res.json(response);
});

module.exports = app;
