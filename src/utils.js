const percentage = (percent, total) => {
  return ((percent / 100) * total).toFixed(2);
};

const isValidDate = (stringDate) => {
  const regex = /\d{4}-(0\d{1}|1[0-2])-([0-2]\d{1}|3[0-1])/;
  return stringDate.match(regex);
};

module.exports = { percentage, isValidDate };
